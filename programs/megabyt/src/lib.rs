use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod payouts;
pub mod randomness;
pub mod scoring;
pub mod state;
pub mod validation;

use instructions::*;

declare_id!("2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS");

#[program]
pub mod megabyt {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        treasury: Pubkey,
        ticket_price: u64,
        usdt_mint: Pubkey,
        byti_mint: Pubkey,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            treasury,
            ticket_price,
            usdt_mint,
            byti_mint,
        )
    }

    pub fn initialize_vaults(ctx: Context<InitializeVaults>) -> Result<()> {
        instructions::initialize_vaults::handler(ctx)
    }

    pub fn init_monthly_state(ctx: Context<InitMonthlyState>) -> Result<()> {
        instructions::init_monthly_state::handler(ctx)
    }

    pub fn init_monthly_vault(ctx: Context<InitMonthlyVault>) -> Result<()> {
        instructions::init_monthly_vault::handler(ctx)
    }

    pub fn open_draw(ctx: Context<OpenDraw>, duration: i64) -> Result<()> {
        instructions::open_draw::handler(ctx, duration)
    }

    pub fn open_monthly_draw<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenMonthlyDraw<'info>>,
        first_draw_id: u64,
        last_draw_id: u64,
    ) -> Result<()> {
        instructions::open_monthly_draw::handler(ctx, first_draw_id, last_draw_id)
    }

    pub fn request_monthly_randomness(ctx: Context<RequestMonthlyRandomness>) -> Result<()> {
        instructions::request_monthly_randomness::handler(ctx)
    }

    pub fn close_monthly_draw(ctx: Context<CloseMonthlyDraw>) -> Result<()> {
        instructions::close_monthly_draw::handler(ctx)
    }

    pub fn buy_ticket(
        ctx: Context<BuyTicket>,
        numbers: Vec<u8>,
        crypto: u8,
    ) -> Result<()> {
        instructions::buy_ticket::handler(ctx, numbers, crypto)
    }

    pub fn buy_ticket_with_referral(
        ctx: Context<BuyTicketWithReferral>,
        numbers: Vec<u8>,
        crypto: u8,
    ) -> Result<()> {
        instructions::buy_ticket_with_referral::handler(ctx, numbers, crypto)
    }

    pub fn request_randomness(ctx: Context<RequestRandomness>) -> Result<()> {
        instructions::request_randomness::handler(ctx)
    }

    pub fn verify_randomness(
        ctx: Context<VerifyRandomness>,
        draw_id: u64,
    ) -> Result<()> {
        instructions::verify_randomness::handler(ctx, draw_id)
    }

    pub fn close_draw(ctx: Context<CloseDraw>) -> Result<()> {
        instructions::close_draw::handler(ctx)
    }

    pub fn settle_monthly_tickets<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleMonthlyTickets<'info>>,
        batch_size: u32,
    ) -> Result<()> {
        instructions::settle_monthly_tickets::handler(ctx, batch_size)
    }

    pub fn settle_tickets<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleTickets<'info>>,
        batch_size: u32,
    ) -> Result<()> {
        instructions::settle_tickets::handler(ctx, batch_size)
    }

    pub fn finalize_monthly_payouts(ctx: Context<FinalizeMonthlyPayouts>) -> Result<()> {
        instructions::finalize_monthly_payouts::handler(ctx)
    }

    pub fn finalize_payouts(ctx: Context<FinalizePayouts>) -> Result<()> {
        instructions::finalize_payouts::handler(ctx)
    }

    pub fn pay_winners_batch<'info>(
        ctx: Context<'_, '_, 'info, 'info, PayWinnersBatch<'info>>,
        batch_size: u32,
    ) -> Result<()> {
        instructions::pay_winners_batch::handler(ctx, batch_size)
    }

    pub fn reset_draw_settlement(ctx: Context<ResetDrawSettlement>) -> Result<()> {
        instructions::reset_draw_settlement::handler(ctx)
    }

    pub fn init_user_state(ctx: Context<InitUserState>) -> Result<()> {
        instructions::init_user_state::handler(ctx)
    }

    pub fn set_referrer(ctx: Context<SetReferrer>) -> Result<()> {
        instructions::set_referrer::handler(ctx)
    }

    pub fn claim_bonus_ticket(
        ctx: Context<ClaimBonusTicket>,
        numbers: Vec<u8>,
        crypto: u8,
    ) -> Result<()> {
        instructions::claim_bonus_ticket::handler(ctx, numbers, crypto)
    }

    pub fn advance_phase(ctx: Context<AdvancePhase>) -> Result<()> {
        instructions::advance_phase::handler(ctx)
    }
}

