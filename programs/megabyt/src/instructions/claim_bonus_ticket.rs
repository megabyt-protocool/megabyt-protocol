use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState, Ticket, UserDrawState, UserState};
use crate::validation::{validate_numbers, validate_crypto};

pub fn handler(ctx: Context<ClaimBonusTicket>, numbers: Vec<u8>, crypto: u8) -> Result<()> {
    let user = &ctx.accounts.user;
    let global_state = &mut ctx.accounts.global_state;
    let user_state = &mut ctx.accounts.user_state;
    let user_draw_state = &mut ctx.accounts.user_draw_state;
    let draw_state = &mut ctx.accounts.draw_state;
    let ticket = &mut ctx.accounts.ticket;
    let clock = Clock::get()?;

    // Must have credits
    require!(user_state.bonus_ticket_credits > 0, MegabytError::NoBonusTicketCredits);

    // Draw must be open
    require!(draw_state.is_open, MegabytError::DrawClosed);
    require!(!draw_state.is_closed, MegabytError::DrawAlreadyClosed);
    require!(clock.unix_timestamp <= draw_state.end_time, MegabytError::DrawStillOpen);

    // Initialize user_draw_state if first ticket in this draw
    if user_draw_state.tickets_bought == 0 {
        user_draw_state.user = user.key();
        user_draw_state.draw = draw_state.key();
        user_draw_state.bump = ctx.bumps.user_draw_state;
    }

    // Validate numbers and crypto
    validate_numbers(&numbers, global_state.numbers_count)?;
    validate_crypto(crypto, global_state.crypto_count)?;

    // Supply cap validation: ensure we don't exceed phase limit
    if global_state.total_supply_cap > 0 {
        require!(
            global_state.released_supply < global_state.total_supply_cap,
            MegabytError::SupplyCapExceeded
        );
    }

    // Consume 1 credit
    user_state.bonus_ticket_credits = user_state
        .bonus_ticket_credits
        .checked_sub(1)
        .ok_or(MegabytError::NoBonusTicketCredits)?;

    // Create ticket (NO payment)
    let current_index = user_draw_state.tickets_bought;

    ticket.owner = user.key();
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
    ticket.ticket_index = current_index;

    // Increment ticket counter
    user_draw_state.tickets_bought = user_draw_state
        .tickets_bought
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

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

    // Increment released supply (bonus ticket also consumes supply)
    global_state.released_supply = global_state
        .released_supply
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    msg!("BONUS TICKET CLAIMED");
    msg!("user={}", user.key());
    msg!("draw_id={}", draw_state.id);
    msg!("ticket_index={}", current_index);
    msg!("tickets_bought_by_user={}", user_draw_state.tickets_bought);
    msg!("remaining_credits={}", user_state.bonus_ticket_credits);
    msg!("released_supply={}/{}", global_state.released_supply, global_state.total_supply_cap);

    Ok(())
}

#[derive(Accounts)]
#[instruction(numbers: Vec<u8>, crypto: u8)]
pub struct ClaimBonusTicket<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(
        mut,
        seeds = [b"user-state-v3", user.key().as_ref()],
        bump = user_state.bump,
        constraint = user_state.owner == user.key() @ MegabytError::InvalidTokenOwner
    )]
    pub user_state: Box<Account<'info, UserState>>,

    #[account(
        mut,
        seeds = [b"draw-v3", &draw_state.id.to_le_bytes()],
        bump = draw_state.bump
    )]
    pub draw_state: Box<Account<'info, Draw>>,

    /// User's draw state — tracks ticket count per user per draw.
    /// Created on first buy, reused on subsequent buys.
    #[account(
        init_if_needed,
        payer = user,
        space = UserDrawState::LEN,
        seeds = [b"user-draw", draw_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_draw_state: Box<Account<'info, UserDrawState>>,

    #[account(
        init,
        payer = user,
        space = Ticket::len(&Pubkey::default(), &Pubkey::default(), global_state.numbers_count),
        seeds = [
            b"ticket",
            draw_state.key().as_ref(),
            user.key().as_ref(),
            &user_draw_state.tickets_bought.to_le_bytes()
        ],
        bump
    )]
    pub ticket: Box<Account<'info, Ticket>>,

    pub system_program: Program<'info, System>,
}
