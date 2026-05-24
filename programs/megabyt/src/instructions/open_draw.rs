use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState};

#[derive(Accounts)]
pub struct OpenDraw<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = admin,
        space = Draw::len(global_state.numbers_count),
        seeds = [
            b"draw-v3",
            (global_state.current_draw_id + 1).to_le_bytes().as_ref()
        ],
        bump
    )]
    pub draw_state: Account<'info, Draw>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenDraw>, duration: i64) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    let draw_state = &mut ctx.accounts.draw_state;
    let clock = Clock::get()?;

    require!(duration > 0, MegabytError::InvalidDuration);

    // Maximum duration: 30 days (2,592,000 seconds)
    const MAX_DURATION: i64 = 30 * 24 * 3600;
    require!(duration <= MAX_DURATION, MegabytError::InvalidDuration);

    let next_draw_id = global_state.current_draw_id
        .checked_add(1)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    draw_state.id = next_draw_id;
    draw_state.bump = ctx.bumps.draw_state;

    draw_state.is_open = true;
    draw_state.is_closed = false;
    draw_state.is_paid = false;
    draw_state.settled = false;

    draw_state.start_time = clock.unix_timestamp;
    draw_state.end_time = clock.unix_timestamp
        .checked_add(duration)
        .ok_or(MegabytError::ArithmeticOverflow)?;

    draw_state.total_tickets = 0;
    draw_state.total_amount = 0;
    draw_state.total_collected = 0;
    draw_state.total_pool = 0;
    draw_state.prize_pool = 0;
    draw_state.tickets_sold = 0;

    draw_state.winner = Pubkey::default();

    draw_state.crypto_number = 0;
    draw_state.result_numbers = vec![0u8; global_state.numbers_count as usize];
    draw_state.result_crypto = 0;

    draw_state.winning_numbers = vec![0u8; global_state.numbers_count as usize];
    draw_state.winning_crypto = 0;

    draw_state.randomness_account = Pubkey::default();
    draw_state.commit_slot = 0;

    draw_state.random_seed = [0; 32];
    draw_state.randomness_requested = false;
    draw_state.randomness_fulfilled = false;

    draw_state.tickets_processed = 0;
    draw_state.tickets_paid = 0;
    draw_state.winner_counts = [0; 10];
    draw_state.prize_per_tier = [0; 10];
    draw_state.settlement_complete = false;

    draw_state.status = 0;
    draw_state.monthly_rollover_contribution = 0;
    draw_state.numbers_count = global_state.numbers_count;

    global_state.current_draw_id = next_draw_id;
    global_state.total_draws = global_state
        .total_draws
        .checked_add(1)
        .ok_or(MegabytError::MathOverflow)?;

    Ok(())
}

