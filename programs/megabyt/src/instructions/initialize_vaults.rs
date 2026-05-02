use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::MegabytError;
use crate::state::GlobalState;

#[derive(Accounts)]
pub struct InitializeVaults<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"prize-vault-v3"],
        bump,
        token::mint = token_mint,
        token::authority = vault_authority
    )]
    pub prize_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"treasury-vault-v3"],
        bump,
        token::mint = token_mint,
        token::authority = vault_authority
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"legal-vault-v3"],
        bump,
        token::mint = token_mint,
        token::authority = vault_authority
    )]
    pub legal_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"marketing-vault-v3"],
        bump,
        token::mint = token_mint,
        token::authority = vault_authority
    )]
    pub marketing_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"liquidity-vault-v3"],
        bump,
        token::mint = token_mint,
        token::authority = vault_authority
    )]
    pub liquidity_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA usada somente como autoridade dos vaults SPL
    #[account(
        seeds = [b"vault-authority-v3"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeVaults>) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;

    global_state.token_mint = ctx.accounts.token_mint.key();

    global_state.prize_vault = ctx.accounts.prize_vault.key();
    global_state.treasury_vault = ctx.accounts.treasury_vault.key();
    global_state.legal_vault = ctx.accounts.legal_vault.key();
    global_state.marketing_vault = ctx.accounts.marketing_vault.key();
    global_state.liquidity_vault = ctx.accounts.liquidity_vault.key();

    Ok(())
}

