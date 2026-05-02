use anchor_lang::prelude::*;
use crate::state::GlobalState;

pub fn handler(
    ctx: Context<Initialize>,
    treasury: Pubkey,
    ticket_price: u64,
    usdt_mint: Pubkey,
    byti_mint: Pubkey,
) -> Result<()> {
    let global = &mut ctx.accounts.global_state;

    global.admin = ctx.accounts.admin.key();
    global.treasury = treasury;

    global.token_mint = Pubkey::default();
    global.byti_mint = byti_mint;
    global.usdt_mint = usdt_mint;

    global.ticket_price = ticket_price;
    global.total_users = 0;
    global.active_users = 0;
    global.total_collected = 0;
    global.total_draws = 0;
    global.current_draw_id = 0;
    global.total_volume_byti = 0;
    global.total_revenue_usdt = 0;

    global.total_supply_cap = 0;
    global.released_supply = 0;
    global.current_phase = 0;
    global.current_phase_supply = 0;

    global.numbers_count = 6;
    global.crypto_count = 1;

    global.prize_vault = Pubkey::default();
    global.treasury_vault = Pubkey::default();
    global.legal_vault = Pubkey::default();
    global.marketing_vault = Pubkey::default();
    global.liquidity_vault = Pubkey::default();

    global.byti_ticket_vault = Pubkey::default();
    global.byti_treasury_vault = Pubkey::default();
    global.byti_emission_vault = Pubkey::default();
    global.usdt_reserve_vault = Pubkey::default();
    global.prize_usdt_vault = Pubkey::default();
    global.referral_usdt_vault = Pubkey::default();
    global.legal_usdt_vault = Pubkey::default();
    global.ops_usdt_vault = Pubkey::default();
    global.admin_usdt_vault = Pubkey::default();

    global.monthly_pool = 0;
    global.monthly_cycle_start = 0;
    global.monthly_cycle_duration = 0;
    global.last_monthly_rollover_at = 0;
    global.monthly_cycles_completed = 0;

    global.admin_total = 0;
    global.security_total = 0;
    global.referral_total = 0;
    global.costs_total = 0;
    global.monthly_total = 0;
    global.daily_total = 0;

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = GlobalState::LEN,
        seeds = [b"global-state-v3"],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,

    pub system_program: Program<'info, System>,
}

