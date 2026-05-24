use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState, Ticket, UserDrawState};
use crate::validation::{validate_numbers, validate_crypto};

#[derive(Accounts)]
#[instruction(numbers: Vec<u8>, crypto: u8)]
pub struct BuyTicket<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global-state-v3"],
        bump
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(mut)]
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

    /// Ticket PDA now includes ticket_index for multi-ticket support.
    /// ticket_index comes from user_draw_state.tickets_bought BEFORE increment.
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

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ MegabytError::InvalidTokenOwner
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = prize_vault.key() == global_state.prize_vault @ MegabytError::InvalidPrizeVault
    )]
    pub prize_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BuyTicket>, numbers: Vec<u8>, crypto: u8) -> Result<()> {
    let user = &ctx.accounts.user;
    let global_state = &mut ctx.accounts.global_state;
    let draw_state = &mut ctx.accounts.draw_state;
    let ticket = &mut ctx.accounts.ticket;
    let user_draw_state = &mut ctx.accounts.user_draw_state;
    let clock = Clock::get()?;

    require!(draw_state.is_open, MegabytError::DrawClosed);
    require!(!draw_state.is_closed, MegabytError::DrawAlreadyClosed);
    require!(clock.unix_timestamp <= draw_state.end_time, MegabytError::DrawStillOpen);

    validate_numbers(&numbers, global_state.numbers_count)?;
    validate_crypto(crypto, global_state.crypto_count)?;

    require!(
        ctx.accounts.user_token_account.amount >= global_state.ticket_price,
        MegabytError::InvalidTicket
    );

    // Initialize user_draw_state if first ticket in this draw
    if user_draw_state.tickets_bought == 0 {
        user_draw_state.user = user.key();
        user_draw_state.draw = draw_state.key();
        user_draw_state.bump = ctx.bumps.user_draw_state;
    }

    // Transfer ticket price to prize vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.prize_vault.to_account_info(),
            authority: user.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, global_state.ticket_price)?;

    // Create ticket with current index
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

    draw_state.total_amount = draw_state
        .total_amount
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    draw_state.total_collected = draw_state
        .total_collected
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    draw_state.total_pool = draw_state
        .total_pool
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    draw_state.prize_pool = draw_state
        .prize_pool
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // Only count as new user on FIRST ticket ever (index 0, first draw)
    if current_index == 0 {
        global_state.total_users = global_state
            .total_users
            .checked_add(1)
            .ok_or(MegabytError::ArithmeticOverflow)?;

        global_state.active_users = global_state
            .active_users
            .checked_add(1)
            .ok_or(MegabytError::ArithmeticOverflow)?;
    }

    global_state.total_collected = global_state
        .total_collected
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    global_state.total_revenue_usdt = global_state
        .total_revenue_usdt
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    msg!("TICKET BOUGHT");
    msg!("user={}", user.key());
    msg!("draw_id={}", draw_state.id);
    msg!("ticket_index={}", current_index);
    msg!("tickets_bought_by_user={}", user_draw_state.tickets_bought);

    Ok(())
}
