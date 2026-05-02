use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState, Ticket, UserState};

pub fn handler(ctx: Context<ClaimBonusTicket>, numbers: [u8; 6], crypto: u8) -> Result<()> {
    let user_state = &mut ctx.accounts.user_state;
    let draw_state = &mut ctx.accounts.draw_state;
    let ticket = &mut ctx.accounts.ticket;
    let clock = Clock::get()?;

    // Must have credits
    require!(user_state.bonus_ticket_credits > 0, MegabytError::NoBonusTicketCredits);

    // Draw must be open
    require!(draw_state.is_open, MegabytError::DrawClosed);
    require!(!draw_state.is_closed, MegabytError::DrawAlreadyClosed);
    require!(clock.unix_timestamp <= draw_state.end_time, MegabytError::DrawStillOpen);

    // Validate numbers and crypto
    validate_numbers(&numbers)?;
    validate_crypto(crypto)?;

    // Consume 1 credit
    user_state.bonus_ticket_credits = user_state
        .bonus_ticket_credits
        .checked_sub(1)
        .ok_or(MegabytError::NoBonusTicketCredits)?;

    // Create ticket (NO payment)
    ticket.owner = ctx.accounts.user.key();
    ticket.draw = draw_state.key();
    ticket.draw_id = draw_state.id;
    ticket.numbers = numbers;
    ticket.crypto = crypto;
    ticket.crypto_number = crypto;
    ticket.claimed = false;
    ticket.settled = false;
    ticket.paid = false;
    ticket.tier = 255;
    ticket.prize_amount = 0;
    ticket.bump = ctx.bumps.ticket;

    // Update draw counters
    draw_state.total_tickets = draw_state
        .total_tickets
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    draw_state.tickets_sold = draw_state
        .tickets_sold
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // Note: no total_amount / total_collected increase (bonus = free)

    msg!("BONUS TICKET CLAIMED");
    msg!("user={}", ctx.accounts.user.key());
    msg!("draw_id={}", draw_state.id);
    msg!("remaining_credits={}", user_state.bonus_ticket_credits);

    Ok(())
}

fn validate_numbers(numbers: &[u8; 6]) -> Result<()> {
    for n in numbers.iter() {
        require!(*n >= 1 && *n <= 72, MegabytError::InvalidNumber);
    }
    for i in 0..numbers.len() {
        for j in (i + 1)..numbers.len() {
            require!(numbers[i] != numbers[j], MegabytError::DuplicateNumber);
        }
    }
    Ok(())
}

fn validate_crypto(crypto: u8) -> Result<()> {
    require!(crypto >= 1 && crypto <= 10, MegabytError::InvalidCryptoNumber);
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimBonusTicket<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user-state-v3", user.key().as_ref()],
        bump = user_state.bump,
        constraint = user_state.owner == user.key() @ MegabytError::InvalidTokenOwner
    )]
    pub user_state: Account<'info, UserState>,

    #[account(mut)]
    pub draw_state: Box<Account<'info, Draw>>,

    #[account(
        init,
        payer = user,
        space = Ticket::LEN,
        seeds = [b"ticket", draw_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub ticket: Box<Account<'info, Ticket>>,

    pub system_program: Program<'info, System>,
}
