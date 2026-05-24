use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::{Draw, GlobalState};

pub fn handler(ctx: Context<RequestRandomness>) -> Result<()> {
    let draw = &mut ctx.accounts.draw;
    let global_state = &ctx.accounts.global_state;
    let clock = Clock::get()?;

    // Only admin can request randomness
    require!(
        global_state.admin == ctx.accounts.admin.key(),
        MegabytError::Unauthorized
    );

    require!(draw.is_open, MegabytError::DrawClosed);
    require!(!draw.is_closed, MegabytError::DrawAlreadyClosed);
    require!(draw.tickets_sold > 0, MegabytError::NoTicketsSold);

    // Anti-replay: bloquear se ja foi solicitado
    require!(!draw.randomness_requested, MegabytError::InvalidDrawState);

    // =========================================================
    //  FECHAR VENDAS — impede front-running via VRF leak
    //
    //  A partir daqui, buy_ticket falha porque is_open = false.
    //  close_draw continua funcionando
    //  porque valida !is_closed + randomness_requested.
    // =========================================================
    draw.is_open = false;

    // Registrar request
    draw.randomness_requested = true;
    draw.randomness_fulfilled = false;

    // Vincular conta de randomness a esta draw
    draw.randomness_account = ctx.accounts.randomness_account.key();

    // Salvar slot do request para auditoria
    draw.commit_slot = clock.slot;

    // Resetar seed anterior (se existir de tentativa abortada)
    draw.random_seed = [0u8; 32];

    msg!("RANDOMNESS REQUEST REGISTERED");
    msg!("draw_id={}", draw.id);
    msg!("randomness_account={}", draw.randomness_account);
    msg!("commit_slot={}", draw.commit_slot);

    Ok(())
}

#[derive(Accounts)]
pub struct RequestRandomness<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"draw-v3", &draw.id.to_le_bytes()],
        bump = draw.bump
    )]
    pub draw: Account<'info, Draw>,

    /// CHECK: conta de randomness da Switchboard; apenas registramos a pubkey aqui.
    pub randomness_account: AccountInfo<'info>,
}
