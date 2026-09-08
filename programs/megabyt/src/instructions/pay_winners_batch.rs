use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState, Ticket};

/// Paga um lote de vencedores numa unica transacao.
///
/// - O primeiro ticket vem pelas contas nomeadas (`ticket` + `user_token_account`),
///   preservando compatibilidade com quem ja chamava `pay_winners_batch(1)`.
/// - Tickets adicionais vem via `remaining_accounts`, em PARES ordenados:
///     [ticket_1, user_ata_1, ticket_2, user_ata_2, ...]
/// - `batch_size` = numero total de tickets a processar nesta tx (incluindo o
///   nomeado). `batch_size <= 1` processa so o ticket nomeado (comportamento antigo).
/// - Idempotente: um ticket ja pago e pulado sem erro, permitindo reenvio seguro
///   do mesmo lote (retry) sem duplicar pagamento nem abortar a transacao inteira.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, PayWinnersBatch<'info>>,
    batch_size: u32,
) -> Result<()> {
    let program_id = ctx.program_id;
    let draw_key = ctx.accounts.draw.key();

    // Aceita status 3 (finalizado, pagamento em andamento) OU 4 (ja totalmente
    // pago). Isso e o que torna o reenvio do LOTE inteiro idempotente: sem
    // isso, reenviar exatamente o lote que completa o draw (status 3 -> 4)
    // seria rejeitado com DrawNotReady mesmo sem nada de errado ter
    // acontecido, so porque o guard barrava antes de chegar no loop que
    // pula tickets ja pagos.
    require!(
        ctx.accounts.draw.status == 3 || ctx.accounts.draw.status == 4,
        MegabytError::DrawNotReady
    );

    let total_winners: u64 = ctx
        .accounts
        .draw
        .winner_counts
        .iter()
        .try_fold(0u64, |acc, &count| {
            acc.checked_add(count).ok_or(MegabytError::MathOverflow)
        })?;

    // Caminho rapido para draw sem vencedores
    if total_winners == 0 {
        let draw = &mut ctx.accounts.draw;
        draw.is_paid = true;
        draw.status = 4;

        msg!("NO WINNERS - MARKING DRAW AS PAID");
        msg!("draw_id={}", draw.id);
        msg!("total_winners={}", total_winners);
        msg!("is_paid={}", draw.is_paid);

        return Ok(());
    }

    // Validacoes de vault — uma vez por transacao, valem pra todos os tickets do lote
    require!(
        ctx.accounts.prize_vault.owner == ctx.accounts.vault_authority.key(),
        MegabytError::InvalidVaultAuthority
    );
    require!(
        ctx.accounts.prize_vault.key() == ctx.accounts.global_state.prize_vault,
        MegabytError::InvalidPrizeVault
    );

    // Copia dos premios por tier ([u64; 10] e Copy) — reaproveitada em todo o lote
    let prize_per_tier = ctx.accounts.draw.prize_per_tier;

    // Seeds de assinatura do vault authority (uma vez, reaproveitadas em todo o lote)
    let bump = [ctx.bumps.vault_authority];
    let signer_seeds: &[&[u8]] = &[b"vault-authority-v3", &bump];
    let signer: &[&[&[u8]]] = &[signer_seeds];

    let vault_authority_ai = ctx.accounts.vault_authority.to_account_info();
    let token_program_ai = ctx.accounts.token_program.to_account_info();

    let mut processed_now: u64 = 0;

    // -------------------------------------------------------------
    //  Ticket 1: contas nomeadas (compat com pay_winners_batch(1))
    // -------------------------------------------------------------
    {
        let paid = pay_ticket(
            &mut *ctx.accounts.ticket,
            &*ctx.accounts.user_token_account,
            draw_key,
            &prize_per_tier,
            &*ctx.accounts.prize_vault,
            &vault_authority_ai,
            &token_program_ai,
            signer,
        )?;

        if paid {
            processed_now = processed_now
                .checked_add(1)
                .ok_or(MegabytError::MathOverflow)?;
        }
    }

    // -------------------------------------------------------------
    //  Tickets extras: pares [ticket, user_ata] em remaining_accounts
    // -------------------------------------------------------------
    let requested = core::cmp::max(batch_size, 1) as usize;
    let max_extra = requested.saturating_sub(1);

    for pair in ctx.remaining_accounts.chunks_exact(2).take(max_extra) {
        let mut ticket_acc: Account<'info, Ticket> = Account::try_from(&pair[0])?;
        let ata_acc: Account<'info, TokenAccount> = Account::try_from(&pair[1])?;

        let paid = pay_ticket(
            &mut ticket_acc,
            &ata_acc,
            draw_key,
            &prize_per_tier,
            &*ctx.accounts.prize_vault,
            &vault_authority_ai,
            &token_program_ai,
            signer,
        )?;

        if paid {
            // Persiste a escrita — contas de remaining_accounts nao sao
            // auto-salvas pelo Anchor como as contas nomeadas da struct.
            ticket_acc.exit(program_id)?;
            processed_now = processed_now
                .checked_add(1)
                .ok_or(MegabytError::MathOverflow)?;
        }
    }

    let draw = &mut ctx.accounts.draw;

    draw.tickets_paid = draw
        .tickets_paid
        .checked_add(processed_now)
        .ok_or(MegabytError::MathOverflow)?;

    if draw.tickets_paid >= total_winners {
        draw.is_paid = true;
        draw.status = 4;
    }

    msg!("WINNER PAYMENTS PROCESSED");
    msg!("draw_id={}", draw.id);
    msg!("processed_now={}", processed_now);
    msg!("tickets_paid={}", draw.tickets_paid);
    msg!("total_winners={}", total_winners);
    msg!("is_paid={}", draw.is_paid);

    Ok(())
}

/// Paga um unico ticket vencedor, se ainda nao foi pago.
///
/// Retorna `Ok(false)` (sem erro) para tickets ja pagos ou sem premio (tier 255) —
/// isso e o que torna o lote idempotente e tolerante a reenvio.
fn pay_ticket<'info>(
    ticket: &mut Account<'info, Ticket>,
    user_ata: &Account<'info, TokenAccount>,
    draw_key: Pubkey,
    prize_per_tier: &[u64; 10],
    prize_vault: &Account<'info, TokenAccount>,
    vault_authority_ai: &AccountInfo<'info>,
    token_program_ai: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
) -> Result<bool> {
    // Ja pago: pula sem erro (idempotente — permite reenviar o mesmo lote)
    if ticket.paid {
        return Ok(false);
    }

    require!(ticket.draw == draw_key, MegabytError::InvalidTicket);
    require!(ticket.settled, MegabytError::TicketNotSettled);

    require!(
        user_ata.owner == ticket.owner,
        MegabytError::InvalidTokenOwner
    );
    require!(
        user_ata.mint == prize_vault.mint,
        MegabytError::InvalidMint
    );

    let amount = match ticket.tier {
        0..=9 => prize_per_tier[ticket.tier as usize],
        // Tier 255 = sem premio: nao e vencedor, nao conta, nao paga.
        255 => return Ok(false),
        _ => return err!(MegabytError::InvalidTier),
    };

    // So transfere se houver valor real (regra anti-esmola pode ter zerado o tier)
    if amount > 0 {
        let cpi_accounts = Transfer {
            from: prize_vault.to_account_info(),
            to: user_ata.to_account_info(),
            authority: vault_authority_ai.clone(),
        };

        transfer(
            CpiContext::new_with_signer(token_program_ai.clone(), cpi_accounts, signer),
            amount,
        )?;
    }

    // Mesmo com amount = 0 o ticket foi processado logicamente
    ticket.paid = true;

    Ok(true)
}

#[derive(Accounts)]
pub struct PayWinnersBatch<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    // NOTA: os `Account<T>` grandes desta struct sao `Box<>` de proposito.
    // Adicionar `admin` + o `has_one`/seeds no global_state levou o
    // try_accounts gerado pelo #[derive(Accounts)] a estourar o limite de
    // stack frame do BPF (4096 bytes). Box<> move as contas pro heap.
    // Mesmo padrao das 8 instrucoes do sorteio mensal. Nao muda logica.
    #[account(
        mut,
        seeds = [b"draw-v3", &draw.id.to_le_bytes()],
        bump = draw.bump
    )]
    pub draw: Box<Account<'info, Draw>>,

    #[account(mut)]
    pub ticket: Box<Account<'info, Ticket>>,

    #[account(
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(mut)]
    pub prize_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA authority for vault signing
    #[account(
        seeds = [b"vault-authority-v3"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}
