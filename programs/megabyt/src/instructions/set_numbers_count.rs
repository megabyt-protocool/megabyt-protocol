use anchor_lang::prelude::*;

use crate::constants::DRAWN_NUMBERS;
use crate::error::MegabytError;
use crate::state::{GlobalState, Ticket};

/// Define global_state.numbers_count diretamente. Admin-gated, aceita
/// qualquer valor em DRAWN_NUMBERS(6)..=Ticket::MAX_NUMBERS(25).
///
/// Etapa 3: numbers_count deixou de ser o tamanho EXATO da cartela pra ser
/// o TETO (validate_numbers agora aceita 6..=numbers_count). Mirror de
/// set_crypto_count — existe pelo mesmo motivo: advance_phase.rs só muda
/// esse campo na transição de fase; uma instância já inicializada (ex: a
/// devnet atual) precisa de um jeito de corrigir o teto sem reinicializar
/// do zero.
pub fn handler(ctx: Context<SetNumbersCount>, numbers_count: u8) -> Result<()> {
    require!(
        numbers_count >= DRAWN_NUMBERS && numbers_count <= Ticket::MAX_NUMBERS as u8,
        MegabytError::InvalidNumbersCount
    );

    let global_state = &mut ctx.accounts.global_state;
    let previous = global_state.numbers_count;
    global_state.numbers_count = numbers_count;

    msg!("NUMBERS COUNT UPDATED");
    msg!("previous={} new={}", previous, numbers_count);

    Ok(())
}

#[derive(Accounts)]
pub struct SetNumbersCount<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Account<'info, GlobalState>,
}
