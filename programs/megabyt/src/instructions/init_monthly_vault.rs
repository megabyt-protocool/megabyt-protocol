use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::MegabytError;
use crate::state::{GlobalState, MonthlyState};

/// Cria o vault SPL dedicado ao pool mensal e registra sua pubkey em
/// MonthlyState. So criacao de conta — nenhum token e movido aqui (o
/// sweep do prize_vault pro monthly_vault fica pra uma etapa futura,
/// junto com open_monthly_draw).
pub fn handler(ctx: Context<InitMonthlyVault>) -> Result<()> {
    let monthly_state = &mut ctx.accounts.monthly_state;

    monthly_state.monthly_vault = ctx.accounts.monthly_vault.key();

    msg!("MONTHLY VAULT INITIALIZED");
    msg!("monthly_vault={}", monthly_state.monthly_vault);

    Ok(())
}

#[derive(Accounts)]
pub struct InitMonthlyVault<'info> {
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
        seeds = [b"monthly-state-v3"],
        bump = monthly_state.bump
    )]
    pub monthly_state: Account<'info, MonthlyState>,

    // Mesmo mint do prize_vault (o vault mensal guarda o mesmo token dos
    // premios diarios — 20% do faturado por sorteio, ver close_draw.rs).
    #[account(
        constraint = token_mint.key() == global_state.token_mint @ MegabytError::InvalidMint
    )]
    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"monthly-vault-v3"],
        bump,
        token::mint = token_mint,
        token::authority = vault_authority
    )]
    pub monthly_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA usada somente como autoridade dos vaults SPL (mesma do
    /// prize_vault diario e dos demais vaults do protocolo).
    #[account(
        seeds = [b"vault-authority-v3"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
