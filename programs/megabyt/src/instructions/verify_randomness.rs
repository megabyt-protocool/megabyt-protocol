use anchor_lang::prelude::*;
use crate::state::Draw;
use crate::error::MegabytError;

#[derive(Accounts)]
#[instruction(draw_id: u64)]
pub struct VerifyRandomness<'info> {
    #[account(
        seeds = [b"draw-v3", &draw_id.to_le_bytes()],
        bump = draw.bump,
    )]
    pub draw: Account<'info, Draw>,

    /// CHECK: The VRF account that Switchboard filled.
    pub randomness_account_data: AccountInfo<'info>,
}

pub fn handler(ctx: Context<VerifyRandomness>, _draw_id: u64) -> Result<()> {
    let draw = &ctx.accounts.draw;
    let randomness_account = &ctx.accounts.randomness_account_data;

    require!(draw.is_closed, MegabytError::DrawNotReady);
    require!(draw.randomness_requested, MegabytError::InvalidDrawState);
    require!(draw.randomness_fulfilled, MegabytError::RandomnessNotReady);

    require_keys_eq!(
        draw.randomness_account,
        randomness_account.key(),
        MegabytError::InvalidDrawState
    );

    msg!("VERIFY RANDOMNESS OK");
    msg!("draw_id={}", draw.id);
    msg!("randomness_account={}", randomness_account.key());

    Ok(())
}

