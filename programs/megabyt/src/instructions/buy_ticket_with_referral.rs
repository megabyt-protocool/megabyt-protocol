use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState, Ticket, UserState};

#[derive(Accounts)]
pub struct BuyTicketWithReferral<'info> {
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

    #[account(
        init,
        payer = user,
        space = Ticket::LEN,
        seeds = [b"ticket", draw_state.key().as_ref(), user.key().as_ref()],
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

    /// User's own state (must exist)
    #[account(
        mut,
        seeds = [b"user-state-v3", user.key().as_ref()],
        bump = user_state.bump,
        constraint = user_state.owner == user.key() @ MegabytError::InvalidTokenOwner
    )]
    pub user_state: Box<Account<'info, UserState>>,

    /// Referrer's user state
    #[account(
        mut,
        seeds = [b"user-state-v3", referrer_state.owner.as_ref()],
        bump = referrer_state.bump
    )]
    pub referrer_state: Box<Account<'info, UserState>>,

    /// Referrer's token account (must be owned by referrer, same mint as prize_vault)
    #[account(
        mut,
        constraint = referrer_token_account.owner == referrer_state.owner @ MegabytError::ReferralTokenAccountInvalid
    )]
    pub referrer_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BuyTicketWithReferral>, numbers: [u8; 6], crypto: u8) -> Result<()> {
    let user = &ctx.accounts.user;
    let global_state = &mut ctx.accounts.global_state;
    let draw_state = &mut ctx.accounts.draw_state;
    let ticket = &mut ctx.accounts.ticket;
    let user_state = &mut ctx.accounts.user_state;
    let referrer_state = &mut ctx.accounts.referrer_state;
    let clock = Clock::get()?;

    // === VALIDATIONS (same as buy_ticket) ===
    require!(draw_state.is_open, MegabytError::DrawClosed);
    require!(!draw_state.is_closed, MegabytError::DrawAlreadyClosed);
    require!(clock.unix_timestamp <= draw_state.end_time, MegabytError::DrawStillOpen);

    validate_numbers(&numbers)?;
    validate_crypto(crypto)?;

    require!(
        ctx.accounts.user_token_account.amount >= global_state.ticket_price,
        MegabytError::InvalidTicket
    );

    // === REFERRAL VALIDATION ===
    require!(user_state.has_referrer, MegabytError::InvalidReferrer);
    require!(
        user_state.referrer == referrer_state.owner,
        MegabytError::InvalidReferrer
    );

    // === CALCULATE SPLIT ===
    let referral_amount = global_state.ticket_price
        .checked_mul(5)
        .ok_or(MegabytError::ArithmeticOverflow)?
        .checked_div(100)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    let prize_amount = global_state.ticket_price
        .checked_sub(referral_amount)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // === TRANSFER 5% TO REFERRER ===
    let referral_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.referrer_token_account.to_account_info(),
            authority: user.to_account_info(),
        },
    );
    token::transfer(referral_ctx, referral_amount)?;

    // === TRANSFER 95% TO PRIZE VAULT ===
    let prize_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.prize_vault.to_account_info(),
            authority: user.to_account_info(),
        },
    );
    token::transfer(prize_ctx, prize_amount)?;

    // === UPDATE REFERRER EARNINGS ===
    referrer_state.total_referral_earned = referrer_state
        .total_referral_earned
        .checked_add(referral_amount)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    global_state.referral_total = global_state
        .referral_total
        .checked_add(referral_amount)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    msg!("REFERRAL PAYOUT: {} to {}", referral_amount, referrer_state.owner);

    // === DETECT FIRST PURCHASE (CONVERSION) ===
    if !user_state.counted_as_referral_conversion {
        user_state.counted_as_referral_conversion = true;

        referrer_state.successful_referrals = referrer_state
            .successful_referrals
            .checked_add(1)
            .ok_or(MegabytError::ArithmeticOverflow)?;

        msg!(
            "REFERRAL CONVERSION: user {} is referral #{} for {}",
            user.key(),
            referrer_state.successful_referrals,
            referrer_state.owner
        );

        // Every 2 conversions = 1 bonus ticket credit
        if referrer_state.successful_referrals % 2 == 0 {
            referrer_state.bonus_ticket_credits = referrer_state
                .bonus_ticket_credits
                .checked_add(1)
                .ok_or(MegabytError::ArithmeticOverflow)?;

            msg!(
                "BONUS TICKET CREDIT: {} now has {} credits",
                referrer_state.owner,
                referrer_state.bonus_ticket_credits
            );
        }
    }

    // === CREATE TICKET (same as buy_ticket) ===
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

    // === UPDATE DRAW COUNTERS (same as buy_ticket) ===
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

    global_state.total_users = global_state
        .total_users
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    global_state.active_users = global_state
        .active_users
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    global_state.total_collected = global_state
        .total_collected
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    global_state.total_revenue_usdt = global_state
        .total_revenue_usdt
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    msg!("TICKET BOUGHT WITH REFERRAL");
    msg!("user={}", user.key());
    msg!("draw_id={}", draw_state.id);
    msg!("prize_amount={}", prize_amount);
    msg!("referral_amount={}", referral_amount);

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
