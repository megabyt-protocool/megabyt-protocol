use anchor_lang::prelude::*;

use crate::error::MegabytError;
use crate::state::Draw;

pub fn handler(ctx: Context<RequestRandomness>) -> Result<()> {
    let draw = &mut ctx.accounts.draw;
    let clock = Clock::get()?;

    require!(draw.is_open, MegabytError::DrawClosed);
    require!(!draw.is_closed, MegabytError::DrawAlreadyClosed);
    require!(draw.tickets_sold > 0, MegabytError::NoTicketsSold);

    // Anti-replay: bloquear se ja foi solicitado
    require!(!draw.randomness_requested, MegabytError::InvalidDrawState);

    // =========================================================
    //  FECHAR VENDAS — impede front-running via VRF leak
    //
    //  A partir daqui, buy_ticket falha porque is_open = false.
    //  close_draw e fulfill_randomness continuam funcionando
    //  porque validam !is_closed + randomness_requested.
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
    pub draw: Account<'info, Draw>,

    /// CHECK: conta de randomness da Switchboard; apenas registramos a pubkey aqui.
    pub randomness_account: AccountInfo<'info>,
}
