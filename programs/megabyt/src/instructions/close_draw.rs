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

    // is_open não é mais exigido: request_randomness fecha as vendas (is_open=false)
    // para prevenir front-running. A proteção contra double-close está em !is_closed.
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

    let numbers = generate_unique_numbers(&seed, draw.numbers_count);
    let crypto = unbiased_byte(&seed, 10, 0) + 1; // 1..=10 sem modulo bias

    draw.result_numbers = numbers.clone();
    draw.result_crypto = crypto;
    draw.winning_numbers = numbers.clone();
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

    let max_lookback: u64 = 200;

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

/// Expande o seed de 32 bytes em um buffer de 128 bytes usando Keccak256.
///
/// Cada bloco é hash(seed || counter) para gerar entropia adicional,
/// eliminando modulo bias por rejection sampling sem risco de esgotar bytes.
fn hash_expand(seed: &[u8; 32]) -> [u8; 128] {
    let mut buf = [0u8; 128];

    // Blocos 0..3: hash(seed || [counter]) → 4 × 32 = 128 bytes
    for i in 0u8..4 {
        let h = solana_program::keccak::hashv(&[seed as &[u8], &[i] as &[u8]]);
        let start = (i as usize) * 32;
        buf[start..start + 32].copy_from_slice(&h.0);
    }

    buf
}

/// Rejection sampling: retorna um byte uniforme em `0..max`.
///
/// Rejeita valores >= threshold para eliminar modulo bias.
/// `domain` seleciona qual região do buffer expandido ler primeiro.
fn unbiased_byte(seed: &[u8; 32], max: u8, domain: u8) -> u8 {
    let buf = hash_expand(seed);
    let start = (domain as usize) * 32;
    let threshold = 255 - (255 % max); // rejection threshold

    // Tenta os 32 bytes do bloco `domain`
    for j in 0..32 {
        let val = buf[start + j];
        if val < threshold {
            return val % max;
        }
    }

    // Fallback: varre o resto do buffer (extremamente improvável de chegar aqui)
    for j in 0..128 {
        let val = buf[j];
        if val < threshold {
            return val % max;
        }
    }

    // Praticamente impossível: todos os 128 bytes acima do threshold.
    // Probabilidade ≈ (max/256)^128 ≈ 0 para qualquer max > 1.
    // Retorna valor determinístico como último recurso.
    0
}

/// Gera quantidade dinâmica de números únicos em 1..=72 usando Fisher-Yates parcial com rejection sampling.
///
/// O seed VRF de 32 bytes é expandido via Keccak256 para 128 bytes,
/// eliminando qualquer modulo bias na seleção de índices do pool.
fn generate_unique_numbers(seed: &[u8; 32], count: u8) -> Vec<u8> {
    let mut pool = [0u8; 72];
    for i in 0..72 {
        pool[i] = (i as u8) + 1;
    }

    let buf = hash_expand(seed);

    let mut result = Vec::with_capacity(count as usize);
    let mut available: usize = 72;
    let mut byte_idx: usize = 0;

    for _ in 0..count {
        // Rejection sampling: rejeita bytes que causariam bias
        let threshold = 256 - (256 % available);

        loop {
            let val = if byte_idx < 128 {
                let v = buf[byte_idx];
                byte_idx += 1;
                v
            } else {
                // Fallback: expande mais entropia se esgotar o buffer
                let h = solana_program::keccak::hashv(&[seed as &[u8], &byte_idx.to_le_bytes() as &[u8]]);
                byte_idx += 1;
                h.0[byte_idx % 32]
            };

            if (val as usize) < threshold {
                let idx = (val as usize) % available;
                result.push(pool[idx]);
                pool[idx] = pool[available - 1];
                available -= 1;
                break;
            }
        }
    }

    result.sort();
    result
}
