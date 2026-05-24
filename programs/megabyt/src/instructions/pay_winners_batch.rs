use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState, Ticket};

pub fn handler(ctx: Context<PayWinnersBatch>, _batch_size: u32) -> Result<()> {
    let draw = &mut ctx.accounts.draw;
    let ticket = &mut ctx.accounts.ticket;
    let global_state = &ctx.accounts.global_state;
    let prize_vault = &ctx.accounts.prize_vault;
    let user_token_account = &ctx.accounts.user_token_account;

    require!(draw.status == 3, MegabytError::DrawNotReady);

    let total_winners: u64 = draw
        .winner_counts
        .iter()
        .try_fold(0u64, |acc, &count| {
            acc.checked_add(count).ok_or(MegabytError::MathOverflow)
        })?;

    // Caminho rápido para draw sem vencedores
    if total_winners == 0 {
        draw.is_paid = true;
        draw.status = 4;

        msg!("NO WINNERS - MARKING DRAW AS PAID");
        msg!("draw_id={}", draw.id);
        msg!("total_winners={}", total_winners);
        msg!("is_paid={}", draw.is_paid);

        return Ok(());
    }

    require!(ticket.draw == draw.key(), MegabytError::InvalidTicket);
    require!(ticket.settled, MegabytError::TicketNotSettled);
    require!(!ticket.paid, MegabytError::TicketAlreadyPaid);

    require!(
        user_token_account.owner == ticket.owner,
        MegabytError::InvalidTokenOwner
    );

    require!(
        user_token_account.mint == prize_vault.mint,
        MegabytError::InvalidMint
    );

    require!(
        prize_vault.owner == ctx.accounts.vault_authority.key(),
        MegabytError::InvalidVaultAuthority
    );

    require!(
        prize_vault.key() == global_state.prize_vault,
        MegabytError::InvalidPrizeVault
    );

    let amount = match ticket.tier {
        0..=9 => {
            let tier_index = ticket.tier as usize;
            draw.prize_per_tier[tier_index]
        }
        255 => 0,
        _ => return err!(MegabytError::InvalidTier),
    };

    // Só transfere se houver valor real
    if amount > 0 {
        let signer_seeds: &[&[u8]] = &[b"vault-authority-v3", &[ctx.bumps.vault_authority]];

        let cpi_accounts = Transfer {
            from: prize_vault.to_account_info(),
            to: user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };

        let cpi_program = ctx.accounts.token_program.to_account_info();

        transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[signer_seeds]),
            amount,
        )?;
    }

    // Mesmo com amount = 0, o ticket foi processado logicamente
    ticket.paid = true;

    draw.tickets_paid = draw
        .tickets_paid
        .checked_add(1)
        .ok_or(MegabytError::MathOverflow)?;

    if draw.tickets_paid >= total_winners {
        draw.is_paid = true;
        draw.status = 4;
    }

    msg!("WINNER PAYMENT PROCESSED");
    msg!("draw_id={}", draw.id);
    msg!("ticket={}", ticket.key());
    msg!("amount={}", amount);
    msg!("tickets_paid={}", draw.tickets_paid);
    msg!("total_winners={}", total_winners);
    msg!("is_paid={}", draw.is_paid);

    Ok(())
}

#[derive(Accounts)]
pub struct PayWinnersBatch<'info> {
    #[account(
        mut,
        seeds = [b"draw-v3", &draw.id.to_le_bytes()],
        bump = draw.bump
    )]
    pub draw: Account<'info, Draw>,

    #[account(mut)]
    pub ticket: Account<'info, Ticket>,

    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub prize_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA authority for vault signing
    #[account(
        seeds = [b"vault-authority-v3"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

