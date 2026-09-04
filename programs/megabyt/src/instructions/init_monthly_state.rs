use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::{GlobalState, MonthlyState};

/// Cria o singleton MonthlyState. So estado — nenhum sorteio mensal e
/// aberto aqui. Precisa rodar uma vez, antes de init_monthly_vault.
pub fn handler(ctx: Context<InitMonthlyState>) -> Result<()> {
    let monthly_state = &mut ctx.accounts.monthly_state;

    monthly_state.monthly_vault = Pubkey::default();
    monthly_state.current_monthly_id = 0;
    monthly_state.total_monthly_draws = 0;
    monthly_state.jackpot_carry = 0;
    monthly_state.last_monthly_open_at = 0;
    monthly_state.bump = ctx.bumps.monthly_state;

    msg!("MONTHLY STATE INITIALIZED");

    Ok(())
}

#[derive(Accounts)]
pub struct InitMonthlyState<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = admin,
        space = MonthlyState::LEN,
        seeds = [b"monthly-state-v3"],
        bump
    )]
    pub monthly_state: Account<'info, MonthlyState>,

    pub system_program: Program<'info, System>,
}
