use anchor_lang::prelude::*;
use crate::error::MegabytError;
use crate::state::{Draw, GlobalState};

pub fn handler(ctx: Context<FulfillRandomness>, seed: [u8; 32]) -> Result<()> {
    let global_state = &ctx.accounts.global_state;
    let draw = &mut ctx.accounts.draw;

    require_keys_eq!(
        global_state.admin,
        ctx.accounts.admin.key(),
        MegabytError::Unauthorized
    );

    require!(draw.is_open, MegabytError::DrawClosed);
    require!(!draw.is_closed, MegabytError::DrawAlreadyClosed);
    require!(draw.tickets_sold > 0, MegabytError::NoTicketsSold);
    require!(draw.randomness_requested, MegabytError::InvalidDrawState);

    draw.random_seed = seed;
    draw.randomness_requested = true;
    draw.randomness_fulfilled = true;

    msg!("RANDOMNESS FULFILLED");
    msg!("draw_id={}", draw.id);

    Ok(())
}

#[derive(Accounts)]
pub struct FulfillRandomness<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"global-state-v3"],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub draw: Account<'info, Draw>,
}

