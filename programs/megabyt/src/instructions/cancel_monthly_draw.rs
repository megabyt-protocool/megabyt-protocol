use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::error::MegabytError;
use crate::state::{GlobalState, MonthlyDraw, MonthlyState};

/// Escape hatch de emergencia: aborta um sorteio mensal TRAVADO no status 0
/// e devolve o dinheiro pro prize_vault + global_state.monthly_pool.
///
/// A-1 da auditoria: sem isto, se close_monthly_draw nao consegue rodar
/// (conta de randomness ruim, janela VRF perdida, outage do Switchboard) e
/// request_monthly_randomness nao re-solicita (guard `!randomness_requested`),
/// o `pool_snapshot` fica preso no monthly_vault pra sempre — nao ha reset,
/// cancel nem re-request pro mensal (diferente do diario, que tem
/// reset_draw_settlement).
///
/// SO status 0, de proposito:
///   - status 1+: `result_numbers` ja foi derivado do VRF -> cancelar aqui
///     permitiria grinding (open -> request -> close -> ver o resultado ->
///     cancelar -> reabrir -> repetir ate um resultado favoravel).
///   - status 3: `finalize` ja dividiu/devolveu o rollover; `pay` parcial
///     (status 3 com tickets_paid > 0) -> reverter permitiria pagar um
///     vencedor 2x num mensal futuro que re-cobrisse o range.
///   - status 4: vencedores pagos -> reverter = duplo pagamento garantido.
///
/// No status 0 nao existe NENHUMA MonthlyClaim (settle nunca rodou), entao
/// nao ha contas pra limpar.
///
/// Conservacao — reverso EXATO do open_monthly_draw (S = pool_snapshot):
///   open:   monthly_pool -= S; prize_vault -= S; monthly_vault += S
///   cancel: monthly_vault -= S; prize_vault += S; monthly_pool += S
/// Nada some, nada e inventado. O S volta pro monthly_pool e entra no
/// snapshot do proximo open_monthly_draw que cobrir [first_draw_id, ...].
pub fn handler(ctx: Context<CancelMonthlyDraw>) -> Result<()> {
    // So antes de fechar. Ver doc acima.
    require!(
        ctx.accounts.monthly_draw.status == 0,
        MegabytError::MonthlyDrawNotCancelable
    );

    // So o sorteio mensal MAIS RECENTE — senao o rollback de
    // last_covered_draw_id / current_monthly_id ficaria inconsistente com um
    // mensal posterior. Pra desfazer uma cadeia de travados, cancela da mais
    // nova pra mais velha.
    require!(
        ctx.accounts.monthly_state.current_monthly_id == ctx.accounts.monthly_draw.id,
        MegabytError::MonthlyDrawNotLatest
    );

    let refund = ctx.accounts.monthly_draw.pool_snapshot;
    let first_draw_id = ctx.accounts.monthly_draw.first_draw_id;
    let monthly_id = ctx.accounts.monthly_draw.id;

    // Sanidade: o vault tem que ter pelo menos o snapshot DESTA draw. Pode
    // ter mais (fundos de uma draw travada anterior) — por isso usamos o
    // valor especifico da draw, nunca monthly_vault.amount.
    require!(
        ctx.accounts.monthly_vault.amount >= refund,
        MegabytError::InvalidMonthlyVault
    );

    if refund > 0 {
        let signer_seeds: &[&[u8]] = &[b"vault-authority-v3", &[ctx.bumps.vault_authority]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.monthly_vault.to_account_info(),
            to: ctx.accounts.prize_vault.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();

        transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[signer_seeds]),
            refund,
        )?;

        ctx.accounts.global_state.monthly_pool = ctx
            .accounts
            .global_state
            .monthly_pool
            .checked_add(refund)
            .ok_or(MegabytError::MathOverflow)?;
    }

    // Rollback do estado. As draws diarias [first_draw_id, last_draw_id]
    // voltam a ser cobriveis; o proximo open_monthly_draw recria o PDA deste
    // id (a conta MonthlyDraw e fechada abaixo via `close = admin`).
    //
    // last_covered_draw_id: volta pro valor de ANTES do open desta draw.
    //   - id == 1 (primeiro mensal): nao havia mensal anterior, era 0.
    //     (o `open` do primeiro mensal aceita qualquer first_draw_id, entao
    //     `first_draw_id - 1` nao seria necessariamente 0 — por isso o caso
    //     especial.)
    //   - id >= 2: a contiguidade e' obrigatoria no open, entao
    //     `first_draw_id == (mensal anterior).last_draw_id + 1`, ou seja
    //     `first_draw_id - 1` e' exatamente o last_covered anterior.
    let monthly_state = &mut ctx.accounts.monthly_state;
    monthly_state.last_covered_draw_id = if monthly_id == 1 {
        0
    } else {
        first_draw_id
            .checked_sub(1)
            .ok_or(MegabytError::MathOverflow)?
    };
    monthly_state.current_monthly_id = monthly_id
        .checked_sub(1)
        .ok_or(MegabytError::MathOverflow)?;

    msg!("MONTHLY DRAW CANCELED");
    msg!("monthly_id={}", monthly_id);
    msg!("refunded={}", refund);
    msg!("last_covered_draw_id -> {}", monthly_state.last_covered_draw_id);
    msg!("current_monthly_id -> {}", monthly_state.current_monthly_id);

    Ok(())
}

#[derive(Accounts)]
pub struct CancelMonthlyDraw<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(
        mut,
        seeds = [b"monthly-state-v3"],
        bump = monthly_state.bump
    )]
    pub monthly_state: Box<Account<'info, MonthlyState>>,

    #[account(
        mut,
        close = admin,
        seeds = [b"monthly-draw-v3", &monthly_draw.id.to_le_bytes()],
        bump = monthly_draw.bump
    )]
    pub monthly_draw: Box<Account<'info, MonthlyDraw>>,

    #[account(
        mut,
        constraint = prize_vault.key() == global_state.prize_vault @ MegabytError::InvalidPrizeVault
    )]
    pub prize_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = monthly_vault.key() == monthly_state.monthly_vault @ MegabytError::InvalidMonthlyVault
    )]
    pub monthly_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA usada somente como autoridade dos vaults SPL
    #[account(
        seeds = [b"vault-authority-v3"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}
