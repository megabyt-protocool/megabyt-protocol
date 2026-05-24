use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState, Ticket, UserDrawState, UserGlobalState, UserState};
use crate::validation::{validate_numbers, validate_crypto};

#[derive(Accounts)]
#[instruction(numbers: Vec<u8>, crypto: u8)]
pub struct BuyTicketWithReferral<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global-state-v3"],
        bump
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

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

    /// User's global state — tracks whether this wallet has been counted
    /// in global total_users / active_users. Created on first buy ever.
    #[account(
        init_if_needed,
        payer = user,
        space = UserGlobalState::LEN,
        seeds = [b"user-global-v3", user.key().as_ref()],
        bump
    )]
    pub user_global_state: Box<Account<'info, UserGlobalState>>,

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

pub fn handler(ctx: Context<BuyTicketWithReferral>, numbers: Vec<u8>, crypto: u8) -> Result<()> {
    let user = &ctx.accounts.user;
    let global_state = &mut ctx.accounts.global_state;
    let draw_state = &mut ctx.accounts.draw_state;
    let ticket = &mut ctx.accounts.ticket;
    let user_state = &mut ctx.accounts.user_state;
    let user_draw_state = &mut ctx.accounts.user_draw_state;
    let user_global_state = &mut ctx.accounts.user_global_state;
    let referrer_state = &mut ctx.accounts.referrer_state;
    let clock = Clock::get()?;

    // === VALIDATIONS (same as buy_ticket) ===
    require!(draw_state.is_open, MegabytError::DrawClosed);
    require!(!draw_state.is_closed, MegabytError::DrawAlreadyClosed);
    require!(clock.unix_timestamp <= draw_state.end_time, MegabytError::DrawStillOpen);

    validate_numbers(&numbers, global_state.numbers_count)?;
    validate_crypto(crypto, global_state.crypto_count)?;

    require!(
        ctx.accounts.user_token_account.amount >= global_state.ticket_price,
        MegabytError::InvalidTicket
    );

    // Supply cap validation: ensure we don't exceed phase limit
    // Only check if total_supply_cap is set (> 0)
    if global_state.total_supply_cap > 0 {
        require!(
            global_state.released_supply < global_state.total_supply_cap,
            MegabytError::SupplyCapExceeded
        );
    }

    // Initialize user_draw_state if first ticket in this draw
    if user_draw_state.tickets_bought == 0 {
        user_draw_state.user = user.key();
        user_draw_state.draw = draw_state.key();
        user_draw_state.bump = ctx.bumps.user_draw_state;
    }

    // Initialize user_global_state if first ticket ever
    if user_global_state.user == Pubkey::default() {
        user_global_state.user = user.key();
        user_global_state.bump = ctx.bumps.user_global_state;
    }

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

    // === UPDATE DRAW COUNTERS ===
    // IMPORTANTE: draw.total_collected deve refletir apenas o que foi para prize_vault (95%)
    // porque close_draw usa esse valor para redistribuir tokenomics.
    // O referral (5%) já foi pago diretamente ao referrer e não deve ser redistribuído.
    draw_state.total_tickets = draw_state
        .total_tickets
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    draw_state.tickets_sold = draw_state
        .tickets_sold
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // total_amount = receita bruta (100%)
    draw_state.total_amount = draw_state
        .total_amount
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // total_collected = apenas o que foi para prize_vault (95%)
    draw_state.total_collected = draw_state
        .total_collected
        .checked_add(prize_amount)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // total_pool e prize_pool = apenas o que está no prize_vault (95%)
    draw_state.total_pool = draw_state
        .total_pool
        .checked_add(prize_amount)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    draw_state.prize_pool = draw_state
        .prize_pool
        .checked_add(prize_amount)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // Only count as new user on FIRST ticket ever (across all draws)
    if !user_global_state.counted_globally {
        user_global_state.counted_globally = true;

        global_state.total_users = global_state
            .total_users
            .checked_add(1)
            .ok_or(MegabytError::ArithmeticOverflow)?;

        global_state.active_users = global_state
            .active_users
            .checked_add(1)
            .ok_or(MegabytError::ArithmeticOverflow)?;

        msg!("NEW GLOBAL USER counted: total_users={}", global_state.total_users);
    }

    // global_state.total_collected = apenas o que foi para prize_vault (95%)
    global_state.total_collected = global_state
        .total_collected
        .checked_add(prize_amount)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // global_state.total_revenue_usdt = receita bruta (100%)
    global_state.total_revenue_usdt = global_state
        .total_revenue_usdt
        .checked_add(global_state.ticket_price)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    // Increment released supply (each ticket consumes 1 unit of supply)
    global_state.released_supply = global_state
        .released_supply
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    msg!("TICKET BOUGHT WITH REFERRAL");
    msg!("user={}", user.key());
    msg!("draw_id={}", draw_state.id);
    msg!("ticket_index={}", current_index);
    msg!("tickets_bought_by_user={}", user_draw_state.tickets_bought);
    msg!("prize_amount={}", prize_amount);
    msg!("referral_amount={}", referral_amount);
    msg!("released_supply={}/{}", global_state.released_supply, global_state.total_supply_cap);

    Ok(())
}
