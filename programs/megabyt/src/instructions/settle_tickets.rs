use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::{Draw, Ticket};

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleTickets<'info>>,
    batch_size: u32,
) -> Result<()> {
    let draw = &mut ctx.accounts.draw;
    let program_id = ctx.program_id;

    require!(draw.status == 1 || draw.status == 2, MegabytError::DrawNotReady);
    require!(draw.is_closed, MegabytError::DrawNotReady);
    require!(draw.result_numbers[0] != 0, MegabytError::DrawNotReady);

    // Guard: settlement already complete
    if draw.settlement_complete {
        msg!("SETTLE: settlement already complete. Skipping.");
        return Ok(());
    }

    // Guard: tickets_processed already at limit
    if draw.tickets_processed >= draw.tickets_sold {
        msg!("SETTLE: tickets_processed >= tickets_sold. Marking complete.");
        draw.settlement_complete = true;
        draw.settled = true;
        draw.status = 2;
        return Ok(());
    }

    let max_batch = batch_size as usize;
    let mut processed_now: u64 = 0;

    let remaining_capacity = draw.tickets_sold
        .checked_sub(draw.tickets_processed)
        .ok_or(MegabytError::MathOverflow)?;

    for ticket_info in ctx.remaining_accounts.iter().take(max_batch) {
        // Stop if we reached tickets_sold
        if processed_now >= remaining_capacity {
            msg!("SETTLE: reached tickets_sold limit.");
            break;
        }

        let mut ticket: Account<'info, Ticket> = Account::try_from(ticket_info)?;

        require!(ticket.draw == draw.key(), MegabytError::InvalidTicket);

        // Already settled = skip without counting
        if ticket.settled {
            continue;
        }

        let hits = count_hits(&ticket.numbers, &draw.result_numbers);
        let crypto_hit =
            ticket.crypto == draw.result_crypto || ticket.crypto_number == draw.result_crypto;

        let tier = resolve_tier(hits, crypto_hit);

        ticket.tier = tier;
        ticket.settled = true;
        ticket.prize_amount = 0;

        // PERSIST ticket state to blockchain
        ticket.exit(program_id)?;

        if tier <= 9 {
            let idx = tier as usize;
            draw.winner_counts[idx] = draw.winner_counts[idx]
                .checked_add(1)
                .ok_or(MegabytError::MathOverflow)?;
        }

        processed_now = processed_now
            .checked_add(1)
            .ok_or(MegabytError::MathOverflow)?;
    }

    draw.tickets_processed = draw
        .tickets_processed
        .checked_add(processed_now)
        .ok_or(MegabytError::MathOverflow)?;

    // Cap guard
    if draw.tickets_processed > draw.tickets_sold {
        msg!("SETTLE WARNING: capping tickets_processed to tickets_sold");
        draw.tickets_processed = draw.tickets_sold;
    }

    if draw.tickets_processed >= draw.tickets_sold {
        draw.settlement_complete = true;
        draw.settled = true;
        draw.status = 2;
    }

    msg!("DRAW SETTLEMENT");
    msg!("draw_id={}", draw.id);
    msg!("processed_now={}", processed_now);
    msg!("tickets_processed={}", draw.tickets_processed);
    msg!("tickets_sold={}", draw.tickets_sold);
    msg!("settlement_complete={}", draw.settlement_complete);
    msg!("settled={}", draw.settled);
    msg!("status={}", draw.status);
    msg!("winner_counts={:?}", draw.winner_counts);

    Ok(())
}

fn count_hits(ticket_numbers: &[u8; 6], result_numbers: &[u8; 6]) -> u8 {
    let mut hits = 0u8;

    for n in ticket_numbers.iter() {
        if result_numbers.contains(n) {
            hits += 1;
        }
    }

    hits
}

fn resolve_tier(hits: u8, crypto_hit: bool) -> u8 {
    match (hits, crypto_hit) {
        (6, true) => 0,
        (6, false) => 1,
        (5, true) => 2,
        (5, false) => 3,
        (4, true) => 4,
        (4, false) => 5,
        (3, true) => 6,
        (3, false) => 7,
        (2, true) => 8,
        (2, false) => 9,
        _ => 255,
    }
}

#[derive(Accounts)]
pub struct SettleTickets<'info> {
    #[account(mut)]
    pub draw: Account<'info, Draw>,
}
