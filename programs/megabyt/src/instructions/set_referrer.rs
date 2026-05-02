use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::UserState;

pub fn handler(ctx: Context<SetReferrer>) -> Result<()> {
    let user_state = &mut ctx.accounts.user_state;
    let referrer_state = &ctx.accounts.referrer_state;

    // Cannot set referrer twice
    require!(!user_state.has_referrer, MegabytError::ReferrerAlreadySet);

    // Cannot self-refer
    require!(
        user_state.owner != referrer_state.owner,
        MegabytError::SelfReferralNotAllowed
    );

    // Referrer must be a real user (not default pubkey)
    require!(
        referrer_state.owner != Pubkey::default(),
        MegabytError::InvalidReferrer
    );

    // Set the referrer
    user_state.referrer = referrer_state.owner;
    user_state.has_referrer = true;

    msg!("REFERRER SET");
    msg!("user={}", user_state.owner);
    msg!("referrer={}", user_state.referrer);

    Ok(())
}

#[derive(Accounts)]
pub struct SetReferrer<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user-state-v3", user.key().as_ref()],
        bump = user_state.bump,
        constraint = user_state.owner == user.key() @ MegabytError::InvalidTokenOwner
    )]
    pub user_state: Account<'info, UserState>,

    /// The referrer's user state. Must exist and be owned by someone else.
    #[account(
        seeds = [b"user-state-v3", referrer_state.owner.as_ref()],
        bump = referrer_state.bump
    )]
    pub referrer_state: Account<'info, UserState>,
}
