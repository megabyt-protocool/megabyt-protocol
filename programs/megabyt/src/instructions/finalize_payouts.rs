use anchor_lang::prelude::*;
use crate::error::MegabytError;
use crate::state::{Draw, GlobalState};

/// Minimo de 1 USDT (6 decimals) por premio individual
const MIN_PRIZE_PER_WINNER: u64 = 1_000_000;

pub fn handler(ctx: Context<FinalizePayouts>) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    let draw = &mut ctx.accounts.draw;

    require!(draw.is_closed, MegabytError::DrawNotReady);
    require!(draw.status == 2, MegabytError::DrawNotReady);
    require!(draw.settlement_complete, MegabytError::DrawNotReady);
    require!(draw.settled, MegabytError::DrawNotReady);

    // =========================================================
    //  CASCATA LINEAR + REGRA MINIMO $1 + RESIDUOS MENSAL
    //
    //  Regra simples e correta:
    //  1. Percorre tiers de cima (0) pra baixo (9)
    //  2. Se tier nao tem winner, pool desce pro proximo
    //  3. Se tier tem winner, absorve o carry
    //  4. Depois: calcula individual. Se < $1, pool vai pro mensal
    //  5. Residuos de divisao vao pro mensal
    // =========================================================

    let mut tier_values: [u64; 10] = draw.prize_per_tier;

    let mut total_pool: u64 = 0;
    for i in 0..10 {
        total_pool = total_pool
            .checked_add(tier_values[i])
            .ok_or(MegabytError::MathOverflow)?;
    }

    msg!("CASCATA: total_pool={}", total_pool);

    // --- Passo 1: Cascata linear (carry desce tier a tier) ---
    let mut carry: u64 = 0;

    for i in 0..10 {
        tier_values[i] = tier_values[i]
            .checked_add(carry)
            .ok_or(MegabytError::MathOverflow)?;
        carry = 0;

        if draw.winner_counts[i] == 0 {
            // Sem winner: pool inteiro vira carry pro proximo
            carry = tier_values[i];
            tier_values[i] = 0;
            msg!("CASCATA: tier {} sem winner, carry={}", i, carry);
        } else {
            msg!(
                "CASCATA: tier {} com {} winners, pool={}",
                i, draw.winner_counts[i], tier_values[i]
            );
        }
    }

    // Se sobrou carry apos tier 9, vai pro mensal
    let mut total_monthly_contribution: u64 = 0;

    if carry > 0 {
        total_monthly_contribution = total_monthly_contribution
            .checked_add(carry)
            .ok_or(MegabytError::MathOverflow)?;
        msg!("CASCATA: carry final {} vai pro acumulado mensal", carry);
    }

    // --- Passo 2: Premio individual + regra minimo $1 + residuos ---

    for i in 0..10 {
        if draw.winner_counts[i] > 0 && tier_values[i] > 0 {
            let individual = tier_values[i]
                .checked_div(draw.winner_counts[i])
                .ok_or(MegabytError::MathOverflow)?;

            if individual < MIN_PRIZE_PER_WINNER {
                // Abaixo de $1: pool inteiro vai pro mensal
                msg!(
                    "MINIMO: tier {} premio={} < {} — pool {} vai pro mensal",
                    i, individual, MIN_PRIZE_PER_WINNER, tier_values[i]
                );
                total_monthly_contribution = total_monthly_contribution
                    .checked_add(tier_values[i])
                    .ok_or(MegabytError::MathOverflow)?;
                draw.prize_per_tier[i] = 0;
            } else {
                // Ok: calcula residuo
                let total_paid = individual
                    .checked_mul(draw.winner_counts[i])
                    .ok_or(MegabytError::MathOverflow)?;
                let residual = tier_values[i]
                    .checked_sub(total_paid)
                    .ok_or(MegabytError::MathOverflow)?;

                if residual > 0 {
                    total_monthly_contribution = total_monthly_contribution
                        .checked_add(residual)
                        .ok_or(MegabytError::MathOverflow)?;
                    msg!("RESIDUO: tier {} residuo={}", i, residual);
                }

                draw.prize_per_tier[i] = individual;
                msg!(
                    "FINAL TIER {} => winners={}, pool={}, individual={}",
                    i, draw.winner_counts[i], tier_values[i], individual
                );
            }
        } else {
            draw.prize_per_tier[i] = 0;
        }
    }

    // --- Passo 3: Atualizar acumulado mensal ---
    draw.monthly_rollover_contribution = total_monthly_contribution;

    if total_monthly_contribution > 0 {
        global_state.monthly_pool = global_state
            .monthly_pool
            .checked_add(total_monthly_contribution)
            .ok_or(MegabytError::MathOverflow)?;

        msg!(
            "MONTHLY ROLLOVER: draw {} contribuiu {} pro mensal",
            draw.id, total_monthly_contribution
        );
        msg!("MONTHLY POOL TOTAL: {}", global_state.monthly_pool);
    }

    draw.status = 3;

    msg!("FINALIZE PAYOUTS OK");
    msg!("draw_id={}", draw.id);
    msg!("monthly_rollover={}", draw.monthly_rollover_contribution);
    msg!("winner_counts={:?}", draw.winner_counts);
    msg!("prize_per_tier={:?}", draw.prize_per_tier);

    Ok(())
}

#[derive(Accounts)]
pub struct FinalizePayouts<'info> {
    #[account(mut)]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub draw: Account<'info, Draw>,
}
