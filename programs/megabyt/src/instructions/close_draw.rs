use anchor_lang::prelude::*;
use switchboard_on_demand::accounts::RandomnessAccountData;

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState};

const TIER_BPS: [u64; 10] = [
    5500, // 6 + crypto
    1200, // 6
    800,  // 5 + crypto
    600,  // 5
    500,  // 4 + crypto
    400,  // 4
    300,  // 3 + crypto
    300,  // 3
    250,  // 2 + crypto
    150,  // 2
];

#[derive(Accounts)]
pub struct CloseDraw<'info> {
    #[account(mut)]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub draw: Account<'info, Draw>,

    /// CHECK: conta de randomness da Switchboard; validada contra draw.randomness_account
    pub randomness_account_data: AccountInfo<'info>,
}

pub fn handler(ctx: Context<CloseDraw>) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    let draw = &mut ctx.accounts.draw;
    let clock = Clock::get()?;

    msg!("=== CLOSE DRAW START ===");
    msg!("clock.slot={}", clock.slot);
    msg!("draw.id={}", draw.id);

    // =========================================================
    //  VALIDACOES DE SEGURANCA
    // =========================================================

    require!(draw.is_open, MegabytError::DrawClosed);
    require!(!draw.is_closed, MegabytError::DrawAlreadyClosed);
    require!(draw.tickets_sold > 0, MegabytError::NoTicketsSold);
    require!(draw.randomness_requested, MegabytError::InvalidDrawState);

    // =========================================================
    //  DUAL MODE: PRE-FILLED (test) vs VRF (production)
    //
    //  Mode 1 (test/localnet):
    //    fulfill_randomness already set random_seed + randomness_fulfilled.
    //    We use the pre-filled seed directly. No Switchboard parse needed.
    //
    //  Mode 2 (production/devnet/mainnet):
    //    randomness_fulfilled is false. We parse the Switchboard account,
    //    validate it matches draw.randomness_account, and read the VRF value.
    //    NO FALLBACK. If VRF not ready, tx fails.
    // =========================================================

    let seed: [u8; 32] = if draw.randomness_fulfilled && draw.random_seed != [0u8; 32] {
        // MODE 1: Pre-filled by fulfill_randomness (test/localnet)
        msg!("Using pre-filled randomness (fulfill_randomness path)");
        draw.random_seed
    } else {
        // MODE 2: Production VRF via Switchboard
        msg!("Using Switchboard VRF (production path)");

        // Validate account matches the one registered in request_randomness
        require_keys_eq!(
            ctx.accounts.randomness_account_data.key(),
            draw.randomness_account,
            MegabytError::InvalidDrawState
        );

        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account_data.data.borrow()
        ).map_err(|_| {
            msg!("ERROR: Switchboard account parse failed");
            MegabytError::InvalidDrawState
        })?;

        let revealed_random_value = get_randomness_with_tolerance(
            &randomness_data,
            clock.slot
        ).map_err(|e| {
            msg!("ERROR: VRF not fulfilled yet. Wait for oracle.");
            e
        })?;

        // Mark fulfilled ONLY after real VRF confirmed
        draw.randomness_fulfilled = true;
        draw.random_seed = revealed_random_value;

        revealed_random_value
    };

    msg!("seed={:?}", &seed[..8]);

    // =========================================================
    //  GERAR RESULTADO
    // =========================================================

    let numbers = generate_unique_numbers(&seed);
    let crypto = (seed[6] % 10) + 1;

    draw.result_numbers = numbers;
    draw.result_crypto = crypto;
    draw.winning_numbers = numbers;
    draw.winning_crypto = crypto;

    // =========================================================
    //  TOKENOMICS
    // =========================================================

    let total_collected = draw.total_collected;

    let daily_pool = total_collected
        .checked_mul(60)
        .ok_or(MegabytError::MathOverflow)?
        .checked_div(100)
        .ok_or(MegabytError::MathOverflow)?;

    let monthly_base = total_collected
        .checked_mul(15)
        .ok_or(MegabytError::MathOverflow)?
        .checked_div(100)
        .ok_or(MegabytError::MathOverflow)?;

    let admin_amount = total_collected
        .checked_mul(5)
        .ok_or(MegabytError::MathOverflow)?
        .checked_div(100)
        .ok_or(MegabytError::MathOverflow)?;

    let security_amount = total_collected
        .checked_mul(10)
        .ok_or(MegabytError::MathOverflow)?
        .checked_div(100)
        .ok_or(MegabytError::MathOverflow)?;

    let referral_amount = total_collected
        .checked_mul(5)
        .ok_or(MegabytError::MathOverflow)?
        .checked_div(100)
        .ok_or(MegabytError::MathOverflow)?;

    let costs_amount = total_collected
        .checked_mul(5)
        .ok_or(MegabytError::MathOverflow)?
        .checked_div(100)
        .ok_or(MegabytError::MathOverflow)?;

    let monthly_effective = monthly_base
        .checked_add(referral_amount)
        .ok_or(MegabytError::MathOverflow)?;

    draw.total_pool = daily_pool;
    draw.prize_pool = daily_pool;

    global_state.monthly_pool = global_state
        .monthly_pool
        .checked_add(monthly_effective)
        .ok_or(MegabytError::MathOverflow)?;

    global_state.monthly_total = global_state
        .monthly_total
        .checked_add(monthly_effective)
        .ok_or(MegabytError::MathOverflow)?;

    global_state.daily_total = global_state
        .daily_total
        .checked_add(daily_pool)
        .ok_or(MegabytError::MathOverflow)?;

    global_state.admin_total = global_state
        .admin_total
        .checked_add(admin_amount)
        .ok_or(MegabytError::MathOverflow)?;

    global_state.security_total = global_state
        .security_total
        .checked_add(security_amount)
        .ok_or(MegabytError::MathOverflow)?;

    global_state.costs_total = global_state
        .costs_total
        .checked_add(costs_amount)
        .ok_or(MegabytError::MathOverflow)?;

    // =========================================================
    //  CONTROLE DO CICLO MENSAL
    // =========================================================

    let cycle_end = global_state
        .monthly_cycle_start
        .checked_add(global_state.monthly_cycle_duration)
        .ok_or(MegabytError::MathOverflow)?;

    if clock.unix_timestamp >= cycle_end {
        global_state.last_monthly_rollover_at = clock.unix_timestamp;
        global_state.monthly_cycles_completed = global_state
            .monthly_cycles_completed
            .checked_add(1)
            .ok_or(MegabytError::MathOverflow)?;

        global_state.monthly_cycle_start = clock.unix_timestamp;

        msg!("MONTHLY CYCLE ROLLOVER");
        msg!("monthly_cycles_completed={}", global_state.monthly_cycles_completed);
    }

    // =========================================================
    //  SETUP DOS TIERS
    // =========================================================

    let mut i = 0;
    while i < 10 {
        draw.winner_counts[i] = 0;
        draw.prize_per_tier[i] = daily_pool
            .checked_mul(TIER_BPS[i])
            .ok_or(MegabytError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(MegabytError::MathOverflow)?;
        i += 1;
    }

    // =========================================================
    //  FECHAR DRAW
    // =========================================================

    draw.is_open = false;
    draw.is_closed = true;
    draw.status = 1;

    draw.settled = false;
    draw.settlement_complete = false;
    draw.tickets_processed = 0;

    msg!("DRAW CLOSED");
    msg!("numbers={:?}", numbers);
    msg!("crypto={}", crypto);
    msg!("total_collected={}", total_collected);
    msg!("daily_pool={}", daily_pool);

    Ok(())
}

fn get_randomness_with_tolerance(
    randomness_data: &RandomnessAccountData,
    current_slot: u64,
) -> Result<[u8; 32]> {
    if let Ok(value) = randomness_data.get_value(current_slot) {
        msg!("VRF slot atual OK");
        return Ok(value);
    }

    let max_lookback: u64 = 10_000;

    for i in 1..=max_lookback {
        let slot_try = current_slot.saturating_sub(i);

        if let Ok(value) = randomness_data.get_value(slot_try) {
            msg!("VRF encontrado no slot {}", slot_try);
            return Ok(value);
        }
    }

    msg!("VRF nao encontrado no intervalo de lookback");
    err!(MegabytError::InvalidDrawState)
}

fn generate_unique_numbers(seed: &[u8; 32]) -> [u8; 6] {
    let mut pool = [0u8; 72];
    for i in 0..72 {
        pool[i] = (i as u8) + 1;
    }

    let mut result = [0u8; 6];
    let mut available = 72;

    for i in 0..6 {
        let idx = (seed[i % 32] as usize) % available;
        result[i] = pool[idx];

        pool[idx] = pool[available - 1];
        available -= 1;
    }

    sort_numbers(&mut result);
    result
}

fn sort_numbers(numbers: &mut [u8; 6]) {
    for i in 0..6 {
        for j in i + 1..6 {
            if numbers[j] < numbers[i] {
                let temp = numbers[i];
                numbers[i] = numbers[j];
                numbers[j] = temp;
            }
        }
    }
}
