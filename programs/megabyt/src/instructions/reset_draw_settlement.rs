use anchor_lang::prelude::*;
use crate::error::MegabytError;
use crate::state::{Draw, GlobalState};

/// Admin-only instruction to reset settlement counters on a corrupted draw.
/// Use ONLY when tickets_processed / winner_counts are wrong due to
/// missing ticket.exit() in a previous version of settle_tickets.
///
/// After calling this, re-run settle_tickets with the corrected code.
pub fn handler(ctx: Context<ResetDrawSettlement>) -> Result<()> {
    let draw = &mut ctx.accounts.draw;
    let global_state = &ctx.accounts.global_state;

    // Only admin can reset
    require!(
        ctx.accounts.admin.key() == global_state.admin,
        MegabytError::Unauthorized
    );

    // Only allow reset on draws with status == 2 (settled but not yet finalized).
    // Status 3 means finalize_payouts already ran — resetting would allow double-payment.
    require!(draw.status == 2, MegabytError::DrawNotReady);

    msg!("RESET SETTLEMENT: draw_id={}", draw.id);
    msg!("BEFORE: tickets_processed={}, winner_counts={:?}, status={}",
        draw.tickets_processed, draw.winner_counts, draw.status);

    // Zero out settlement counters
    draw.tickets_processed = 0;
    draw.winner_counts = [0u64; 10];
    draw.settlement_complete = false;
    draw.settled = false;
    draw.status = 1; // Back to "closed, ready for settlement"

    // Do NOT touch: result_numbers, result_crypto, tickets_sold, is_closed

    msg!("AFTER: tickets_processed={}, winner_counts={:?}, status={}",
        draw.tickets_processed, draw.winner_counts, draw.status);
    msg!("RESET SETTLEMENT OK. Re-run settle_tickets now.");

    Ok(())
}

#[derive(Accounts)]
pub struct ResetDrawSettlement<'info> {
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
        mut,
        seeds = [b"draw-v3", &draw.id.to_le_bytes()],
        bump = draw.bump
    )]
    pub draw: Account<'info, Draw>,
}
