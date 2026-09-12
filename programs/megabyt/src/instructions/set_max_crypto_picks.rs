use anchor_lang::prelude::*;

use crate::constants::ALL_CRYPTOS_COUNT;
use crate::error::MegabytError;
use crate::state::GlobalState;

/// Define global_state.max_crypto_picks diretamente. Admin-gated, aceita
/// qualquer valor em 1..=ALL_CRYPTOS_COUNT.
///
/// Etapa 4 (sub-etapa 4b): max_crypto_picks é o teto de QUANTAS cryptos
/// uma cartela pode escolher (não confundir com crypto_count, que é o
/// pool de IDs disponíveis pra escolher DE). Nasce em 1 no `initialize`
/// (comportamento de hoje, 1 crypto por cartela) — esta instrução existe
/// pra destravar mais picks por fase sem precisar reinicializar do zero,
/// mesmo padrão de `set_numbers_count`/`set_crypto_count`.
pub fn handler(ctx: Context<SetMaxCryptoPicks>, max_crypto_picks: u8) -> Result<()> {
    require!(
        max_crypto_picks >= 1 && max_crypto_picks <= ALL_CRYPTOS_COUNT,
        MegabytError::InvalidCryptoCount
    );

    let global_state = &mut ctx.accounts.global_state;
    let previous = global_state.max_crypto_picks;
    global_state.max_crypto_picks = max_crypto_picks;

    msg!("MAX CRYPTO PICKS UPDATED");
    msg!("previous={} new={}", previous, max_crypto_picks);

    Ok(())
}

#[derive(Accounts)]
pub struct SetMaxCryptoPicks<'info> {
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
