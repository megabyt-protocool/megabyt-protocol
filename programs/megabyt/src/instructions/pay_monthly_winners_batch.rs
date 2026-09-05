use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::error::MegabytError;
use crate::state::{GlobalState, MonthlyClaim, MonthlyDraw, MonthlyState};

/// Paga um lote de vencedores do sorteio mensal numa unica transacao.
/// Ultima peca do ciclo mensal (Sub-etapa 3E).
///
/// Molde: pay_winners_batch (Etapa 1) + a MonthlyClaim da 3C.
///
/// - Sem contas nomeadas de vencedor: TODOS os itens do lote vem via
///   `remaining_accounts`, em PARES ordenados:
///       [claim_1, user_ata_1, claim_2, user_ata_2, ...]
///   Cada `claim_i` e' a PDA ["m-claim", monthly_draw, ticket_i], ja criada
///   pelo settle_monthly_tickets (3C). `user_ata_i` e' a ATA do dono
///   (claim.owner) no mesmo mint do monthly_vault.
///
/// - `batch_size` = numero de pares a processar nesta tx. Cada par ocupa 2
///   contas em remaining_accounts, entao o teto pratico e' ~10-13 pares por
///   transacao legada (1232 bytes) — mesma licao documentada no
///   settle_monthly_tickets.rs. Os scripts de operacao do mensal precisam
///   batcher respeitando isso.
///
/// - Valores por tier: `monthly_draw.monthly_prize_per_tier[claim.tier]`,
///   ja calculado pelo finalize_monthly_payouts (3D) — inclui o jackpot
///   individual no indice 0 e a cascata + anti-esmola nos indices 1..9.
///   Tier zerado pelo anti-esmola paga 0 (a claim ainda e' marcada como
///   processada pra fechar a contagem).
///
/// - Tier 255 (perdedor): tem MonthlyClaim (o settle cria pra todo ticket
///   do range) mas NAO conta em monthly_winner_counts e NAO recebe nada —
///   pulado sem erro, sem marcar `paid`, igual ao pay_winners_batch diario.
///
/// - Idempotente: uma claim ja paga e' pulada sem erro, permitindo reenviar
///   o mesmo lote (retry) sem pagar em dobro nem abortar a transacao. Aceita
///   status 3 (finalizado, pagamento em andamento) OU 4 (ja pago) pelo mesmo
///   motivo — sem isso o lote que completa o ciclo (status 3 -> 4) seria
///   rejeitado com DrawNotReady mesmo estando tudo certo.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, PayMonthlyWinnersBatch<'info>>,
    batch_size: u32,
) -> Result<()> {
    let program_id = ctx.program_id;
    let monthly_draw_key = ctx.accounts.monthly_draw.key();

    require!(
        ctx.accounts.monthly_draw.status == 3 || ctx.accounts.monthly_draw.status == 4,
        MegabytError::DrawNotReady
    );

    let total_winners: u64 = ctx
        .accounts
        .monthly_draw
        .monthly_winner_counts
        .iter()
        .try_fold(0u64, |acc, &count| {
            acc.checked_add(count).ok_or(MegabytError::MathOverflow)
        })?;

    // Caminho rapido: nenhum vencedor (jackpot rolou e cascata toda zerada
    // por anti-esmola / tiers vazios). Nada a pagar, so fecha o ciclo.
    if total_winners == 0 {
        let monthly_draw = &mut ctx.accounts.monthly_draw;
        monthly_draw.status = 4;

        msg!("MONTHLY: nenhum vencedor, ciclo fechado");
        msg!("monthly_id={}", monthly_draw.id);

        return Ok(());
    }

    // Validacoes de vault — uma vez por transacao, valem pro lote inteiro.
    require!(
        ctx.accounts.monthly_vault.owner == ctx.accounts.vault_authority.key(),
        MegabytError::InvalidVaultAuthority
    );
    require!(
        ctx.accounts.monthly_vault.key() == ctx.accounts.monthly_state.monthly_vault,
        MegabytError::InvalidMonthlyVault
    );

    // Copia dos premios por tier ([u64; 10] e Copy) — reaproveitada no lote.
    let prize_per_tier = ctx.accounts.monthly_draw.monthly_prize_per_tier;
    let vault_mint = ctx.accounts.monthly_vault.mint;

    // Seeds de assinatura do vault authority (uma vez, reaproveitadas).
    let bump = [ctx.bumps.vault_authority];
    let signer_seeds: &[&[u8]] = &[b"vault-authority-v3", &bump];
    let signer: &[&[&[u8]]] = &[signer_seeds];

    let monthly_vault_ai = ctx.accounts.monthly_vault.to_account_info();
    let vault_authority_ai = ctx.accounts.vault_authority.to_account_info();
    let token_program_ai = ctx.accounts.token_program.to_account_info();

    let max_batch = core::cmp::max(batch_size, 1) as usize;

    let mut processed_now: u64 = 0;

    for pair in ctx.remaining_accounts.chunks_exact(2).take(max_batch) {
        let claim_info = &pair[0];
        let ata_info = &pair[1];

        let mut claim: Account<'info, MonthlyClaim> = Account::try_from(claim_info)?;

        // Claim tem que ser deste sorteio mensal.
        require!(
            claim.monthly_draw == monthly_draw_key,
            MegabytError::InvalidTicket
        );

        // Ja paga: pula sem erro (idempotente — permite reenviar o lote).
        if claim.paid {
            continue;
        }

        // Tier 255 (perdedor): tem claim mas nao e' vencedor. Nao paga, nao
        // marca `paid`, nao conta — igual ao pay_winners_batch diario.
        if claim.tier > 9 {
            continue;
        }

        let ata: Account<'info, TokenAccount> = Account::try_from(ata_info)?;
        require!(ata.owner == claim.owner, MegabytError::InvalidTokenOwner);
        require!(ata.mint == vault_mint, MegabytError::InvalidMint);

        let amount = prize_per_tier[claim.tier as usize];

        // So transfere se houver valor real (o anti-esmola pode ter zerado
        // o tier no finalize).
        if amount > 0 {
            let cpi_accounts = Transfer {
                from: monthly_vault_ai.clone(),
                to: ata.to_account_info(),
                authority: vault_authority_ai.clone(),
            };

            transfer(
                CpiContext::new_with_signer(token_program_ai.clone(), cpi_accounts, signer),
                amount,
            )?;
        }

        // Mesmo com amount = 0 a claim foi processada logicamente.
        claim.paid = true;
        claim.exit(program_id)?;

        processed_now = processed_now
            .checked_add(1)
            .ok_or(MegabytError::MathOverflow)?;
    }

    let monthly_draw = &mut ctx.accounts.monthly_draw;

    monthly_draw.tickets_paid = monthly_draw
        .tickets_paid
        .checked_add(processed_now)
        .ok_or(MegabytError::MathOverflow)?;

    if monthly_draw.tickets_paid > total_winners {
        monthly_draw.tickets_paid = total_winners;
    }

    if monthly_draw.tickets_paid >= total_winners {
        monthly_draw.status = 4;
    }

    msg!("MONTHLY WINNER PAYMENTS PROCESSED");
    msg!("monthly_id={}", monthly_draw.id);
    msg!("processed_now={}", processed_now);
    msg!("tickets_paid={}", monthly_draw.tickets_paid);
    msg!("total_winners={}", total_winners);
    msg!("status={}", monthly_draw.status);

    Ok(())
}

#[derive(Accounts)]
pub struct PayMonthlyWinnersBatch<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(
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
