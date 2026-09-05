use anchor_lang::prelude::*;

use crate::constants::MAX_PHASES;
use crate::error::MegabytError;
use crate::state::GlobalState;

pub fn handler(ctx: Context<AdvancePhase>) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;

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

    // Advance. crypto_count NAO e' mais tocado aqui de proposito — todas
    // as 10 criptos ja ficam disponiveis desde o initialize
    // (ALL_CRYPTOS_COUNT em constants.rs). PhaseConfig.max_cryptos fica
    // sem uso (campo morto, mantido na struct por decisao — menos risco
    // que mexer no layout). Use set_crypto_count se precisar mudar o
    // valor numa instancia ja inicializada.
    global_state.current_phase = next_phase;
    global_state.numbers_count = config.numbers_per_ticket;
    global_state.current_phase_supply = config.supply_to_release;
    global_state.total_supply_cap = config.cumulative_supply;

    msg!("PHASE ADVANCED");
    msg!("new_phase={}", next_phase);
    msg!("active_users={}", global_state.active_users);
    msg!("required={}", config.required_active_users);
    msg!("numbers_per_ticket={}", config.numbers_per_ticket);
    msg!("supply_to_release={}", config.supply_to_release);
    msg!("total_supply_cap={}", config.cumulative_supply);

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
