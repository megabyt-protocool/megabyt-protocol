use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::{GlobalState, MonthlyDraw};

/// Registra a conta de randomness da Switchboard no sorteio mensal.
/// Molde: request_randomness.rs (diario). Diferenca: nao precisa "fechar
/// vendas" — os tickets do range coberto ja estao imutaveis desde que
/// suas draws diarias fecharam, muito antes do mensal ser aberto.
pub fn handler(ctx: Context<RequestMonthlyRandomness>) -> Result<()> {
    let monthly_draw = &mut ctx.accounts.monthly_draw;
    let clock = Clock::get()?;

    require!(monthly_draw.status == 0, MegabytError::DrawNotReady);

    // Anti-replay: bloquear se ja foi solicitado.
    require!(!monthly_draw.randomness_requested, MegabytError::InvalidDrawState);

    monthly_draw.randomness_requested = true;
    monthly_draw.randomness_fulfilled = false;
    monthly_draw.randomness_account = ctx.accounts.randomness_account.key();
    monthly_draw.commit_slot = clock.slot;

    // Reseta seed anterior (se existir de tentativa abortada).
    monthly_draw.random_seed = [0u8; 32];

    msg!("MONTHLY RANDOMNESS REQUEST REGISTERED");
    msg!("monthly_id={}", monthly_draw.id);
    msg!("randomness_account={}", monthly_draw.randomness_account);
    msg!("commit_slot={}", monthly_draw.commit_slot);

    Ok(())
}

#[derive(Accounts)]
pub struct RequestMonthlyRandomness<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(
        mut,
        seeds = [b"monthly-draw-v3", &monthly_draw.id.to_le_bytes()],
        bump = monthly_draw.bump
    )]
    pub monthly_draw: Box<Account<'info, MonthlyDraw>>,

    /// CHECK: conta de randomness da Switchboard; apenas registramos a pubkey aqui.
    pub randomness_account: AccountInfo<'info>,
}
