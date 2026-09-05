use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::constants::MIN_PRIZE_PER_WINNER;
use crate::error::MegabytError;
use crate::payouts::{cascade_and_divide, split_evenly};
use crate::state::{GlobalState, MonthlyDraw, MonthlyState};

/// Calcula o pagamento final do sorteio mensal: divide o jackpot (tier 0)
/// entre seus ganhadores (ou rola pro mes seguinte se nao houver nenhum),
/// aplica a cascata + anti-esmola nos tiers 1..9, e devolve pro
/// prize_vault/monthly_pool tudo que nao vai ser pago a ninguem.
///
/// Prova de conservacao (ver Sub-etapa 3D):
///   pool_snapshot = jackpot_pago_total + Σ(tier_pago[1..9]) + total_rollover
/// onde total_rollover = residuo do jackpot (ou jackpot inteiro, se sem
/// vencedor) + sobra da cascata (cascade_and_divide) + poeira de
/// truncamento do close_monthly_draw (cascade_pool - Σ alocado por tier).
pub fn handler(ctx: Context<FinalizeMonthlyPayouts>) -> Result<()> {
    require!(ctx.accounts.monthly_draw.status == 2, MegabytError::DrawNotReady);

    // -------------------------------------------------------------
    //  Jackpot (tier 0)
    // -------------------------------------------------------------
    let jackpot_pool = ctx.accounts.monthly_draw.jackpot_pool;
    let jackpot_winner_count = ctx.accounts.monthly_draw.monthly_winner_counts[0];

    let (jackpot_individual, jackpot_hit, jackpot_rollover) = if jackpot_winner_count > 0 {
        let (individual, residual) = split_evenly(jackpot_pool, jackpot_winner_count)?;
        msg!("JACKPOT: {} vencedor(es), individual={}, residuo={}", jackpot_winner_count, individual, residual);
        (individual, true, residual)
    } else {
        msg!("JACKPOT: sem vencedor, {} rola pro mes seguinte", jackpot_pool);
        (0, false, jackpot_pool)
    };

    // -------------------------------------------------------------
    //  Cascata + anti-esmola nos tiers 1..9
    // -------------------------------------------------------------
    let cascade_pool = ctx.accounts.monthly_draw.cascade_pool;

    let mut tier_values = [0u64; 9];
    let mut winner_counts_1_9 = [0u64; 9];
    for i in 0..9 {
        tier_values[i] = ctx.accounts.monthly_draw.monthly_prize_per_tier[i + 1];
        winner_counts_1_9[i] = ctx.accounts.monthly_draw.monthly_winner_counts[i + 1];
    }

    // Poeira de truncamento do close_monthly_draw (cascade_pool * peso /
    // 4500 trunca por tier) — capturada aqui pra fechar a conservacao
    // exata, coisa que o diario nunca reconcilia.
    let allocated_sum: u64 = tier_values
        .iter()
        .try_fold(0u64, |acc, &v| acc.checked_add(v).ok_or(MegabytError::MathOverflow))?;
    let close_time_dust = cascade_pool
        .checked_sub(allocated_sum)
        .ok_or(MegabytError::MathOverflow)?;

    let cascade_leftover = cascade_and_divide(&mut tier_values, &winner_counts_1_9, MIN_PRIZE_PER_WINNER)?;

    // -------------------------------------------------------------
    //  Rollover total: sweep-espelho monthly_vault -> prize_vault, e
    //  credito de volta em global_state.monthly_pool (mesma invariante
    //  de sempre: monthly_pool = quanto esta no prize_vault, reservado
    //  pro mensal, ainda nao varrido).
    // -------------------------------------------------------------
    let total_rollover = jackpot_rollover
        .checked_add(cascade_leftover)
        .ok_or(MegabytError::MathOverflow)?
        .checked_add(close_time_dust)
        .ok_or(MegabytError::MathOverflow)?;

    if total_rollover > 0 {
        let signer_seeds: &[&[u8]] = &[b"vault-authority-v3", &[ctx.bumps.vault_authority]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.monthly_vault.to_account_info(),
            to: ctx.accounts.prize_vault.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();

        transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[signer_seeds]),
            total_rollover,
        )?;

        ctx.accounts.global_state.monthly_pool = ctx
            .accounts
            .global_state
            .monthly_pool
            .checked_add(total_rollover)
            .ok_or(MegabytError::MathOverflow)?;

        // Espelho informativo (nunca lido/consumido por nada — so
        // auditoria/visibilidade, igual ao comentario original do campo).
        ctx.accounts.monthly_state.jackpot_carry = ctx
            .accounts
            .monthly_state
            .jackpot_carry
            .checked_add(total_rollover)
            .ok_or(MegabytError::MathOverflow)?;
    }

    // -------------------------------------------------------------
    //  Grava o resultado final.
    // -------------------------------------------------------------
    let monthly_draw = &mut ctx.accounts.monthly_draw;

    monthly_draw.jackpot_hit = jackpot_hit;
    monthly_draw.jackpot_winner_count = jackpot_winner_count;
    monthly_draw.monthly_prize_per_tier[0] = jackpot_individual;
    for i in 0..9 {
        monthly_draw.monthly_prize_per_tier[i + 1] = tier_values[i];
    }
    monthly_draw.rollover_to_next_month = total_rollover;
    monthly_draw.status = 3;

    msg!("MONTHLY FINALIZE OK");
    msg!("monthly_id={}", monthly_draw.id);
    msg!("jackpot_hit={} jackpot_winner_count={}", jackpot_hit, jackpot_winner_count);
    msg!("close_time_dust={}", close_time_dust);
    msg!("total_rollover={}", total_rollover);
    msg!("monthly_prize_per_tier={:?}", monthly_draw.monthly_prize_per_tier);

    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeMonthlyPayouts<'info> {
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
