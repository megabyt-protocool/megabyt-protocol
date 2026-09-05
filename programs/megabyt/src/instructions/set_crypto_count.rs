use anchor_lang::prelude::*;

use crate::constants::ALL_CRYPTOS_COUNT;
use crate::error::MegabytError;
use crate::state::GlobalState;

/// Define global_state.crypto_count diretamente. Admin-gated, aceita
/// qualquer valor em 1..=ALL_CRYPTOS_COUNT.
///
/// Existe porque advance_phase.rs nao mexe mais nesse campo (todas as 10
/// criptos ja saem disponiveis desde o initialize) — mas initialize so
/// roda uma vez, entao uma instancia do protocolo JA INICIALIZADA antes
/// dessa mudanca (ex: a devnet atual, com crypto_count=1 herdado) precisa
/// de um jeito de corrigir esse valor sem reinicializar do zero.
pub fn handler(ctx: Context<SetCryptoCount>, crypto_count: u8) -> Result<()> {
    require!(
        crypto_count >= 1 && crypto_count <= ALL_CRYPTOS_COUNT,
        MegabytError::InvalidCryptoNumber
    );

    let global_state = &mut ctx.accounts.global_state;
    let previous = global_state.crypto_count;
    global_state.crypto_count = crypto_count;

    msg!("CRYPTO COUNT UPDATED");
    msg!("previous={} new={}", previous, crypto_count);

    Ok(())
}

#[derive(Accounts)]
pub struct SetCryptoCount<'info> {
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
