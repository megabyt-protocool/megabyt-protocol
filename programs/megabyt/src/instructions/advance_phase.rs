use anchor_lang::prelude::*;

use crate::constants::{get_phase_config, MAX_PHASES};
use crate::error::MegabytError;
use crate::state::GlobalState;

pub fn handler(ctx: Context<AdvancePhase>) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;

    // Only admin
    require!(
        ctx.accounts.admin.key() == global_state.admin,
        MegabytError::Unauthorized
    );

    // Check current phase
    let current = global_state.current_phase;
    require!(current < MAX_PHASES as u64, MegabytError::MaxPhaseReached);

    // Next phase index (1-based in global_state, 0-indexed in config)
    let next_phase = current + 1;
    let next_idx = (next_phase - 1) as usize;
    let config = &crate::constants::PHASE_CONFIG[std::cmp::min(next_idx, 9)];

    // Check threshold
    require!(
        global_state.active_users >= config.required_active_users,
        MegabytError::PhaseThresholdNotMet
    );

    // Advance
    global_state.current_phase = next_phase;
    global_state.numbers_count = config.numbers_per_ticket;
    global_state.crypto_count = config.max_cryptos;
    global_state.current_phase_supply = config.supply_to_release;

    msg!("PHASE ADVANCED");
    msg!("new_phase={}", next_phase);
    msg!("active_users={}", global_state.active_users);
    msg!("required={}", config.required_active_users);
    msg!("numbers_per_ticket={}", config.numbers_per_ticket);
    msg!("max_cryptos={}", config.max_cryptos);
    msg!("supply_to_release={}", config.supply_to_release);

    Ok(())
}

#[derive(Accounts)]
pub struct AdvancePhase<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global-state-v3"],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
}
