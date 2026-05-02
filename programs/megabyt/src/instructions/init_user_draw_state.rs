use anchor_lang::prelude::*;

use crate::state::{Draw, UserDrawState};

pub fn handler(ctx: Context<InitUserDrawState>) -> Result<()> {
    let user_draw_state = &mut ctx.accounts.user_draw_state;

    user_draw_state.user = ctx.accounts.user.key();
    user_draw_state.draw = ctx.accounts.draw_state.key();
    user_draw_state.tickets_bought = 0;

    Ok(())
}

#[derive(Accounts)]
pub struct InitUserDrawState<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub draw_state: Account<'info, Draw>,

    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 4 + 1,
        seeds = [b"user-draw", draw_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_draw_state: Account<'info, UserDrawState>,

    pub system_program: Program<'info, System>,
}

