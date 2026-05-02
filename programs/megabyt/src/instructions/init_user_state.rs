use anchor_lang::prelude::*;

use crate::state::UserState;

pub fn handler(ctx: Context<InitUserState>) -> Result<()> {
    let user_state = &mut ctx.accounts.user_state;

    user_state.owner = ctx.accounts.user.key();
    user_state.referrer = Pubkey::default();
    user_state.has_referrer = false;
    user_state.counted_as_referral_conversion = false;
    user_state.successful_referrals = 0;
    user_state.total_referral_earned = 0;
    user_state.bonus_ticket_credits = 0;
    user_state.bump = ctx.bumps.user_state;

    msg!("USER STATE INITIALIZED");
    msg!("owner={}", user_state.owner);

    Ok(())
}

#[derive(Accounts)]
pub struct InitUserState<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = UserState::LEN,
        seeds = [b"user-state-v3", user.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    pub system_program: Program<'info, System>,
}
