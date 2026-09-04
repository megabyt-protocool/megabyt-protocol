use anchor_lang::prelude::*;
use switchboard_on_demand::accounts::RandomnessAccountData;

use crate::error::MegabytError;
use crate::randomness::{generate_unique_numbers, get_randomness_with_tolerance, unbiased_byte};
use crate::state::{GlobalState, MonthlyDraw};

/// Pesos de cascata do sorteio mensal (tiers 1..9 — tier 0 e' o jackpot,
/// tratado separadamente em monthly_prize_per_tier[0] = jackpot_pool).
/// Mesma proporcao relativa de TIER_BPS[1..9] em close_draw.rs (diario),
/// sem o tier 0. Somam 4500 (nao 10000) de proposito: dividir cascade_pool
/// direto por esse total e' matematicamente o mesmo que renormalizar esses
/// pesos pra somar 100% e so entao aplicar ao pool — só com UM
/// arredondamento em vez de dois (D2 do plano).
const MONTHLY_CASCADE_TIER_BPS: [u64; 9] = [1200, 800, 600, 500, 400, 300, 300, 250, 150];
const MONTHLY_CASCADE_BPS_SUM: u64 = 4500;

/// Le o seed VRF (mesmo mecanismo do close_draw.rs diario) e deriva
/// result_numbers + result_crypto do sorteio mensal. Divide o
/// cascade_pool nos tiers de cascata (1..9); o jackpot_pool inteiro vai
/// pro tier 0, ainda nao dividido pelos ganhadores. Isso e trabalho do
/// finalize_monthly_payouts, numa etapa futura — aqui so alocamos por
/// peso, igual ao "SETUP DOS TIERS" do close_draw.rs.
pub fn handler(ctx: Context<CloseMonthlyDraw>) -> Result<()> {
    let clock = Clock::get()?;

    require!(ctx.accounts.monthly_draw.status == 0, MegabytError::DrawNotReady);
    require!(
        ctx.accounts.monthly_draw.randomness_requested,
        MegabytError::InvalidDrawState
    );

    // Valida que a conta passada e' a mesma registrada em request_monthly_randomness.
    require_keys_eq!(
        ctx.accounts.randomness_account_data.key(),
        ctx.accounts.monthly_draw.randomness_account,
        MegabytError::InvalidDrawState
    );

    let seed: [u8; 32];

    // =========================================================
    //  SWITCHBOARD VRF / TESTING FALLBACK — mesmo esquema do close_draw.rs
    //
    //  Producao: parse da conta Switchboard real. NO FALLBACK — se o VRF
    //  nao estiver pronto, a tx falha.
    //
    //  Teste (cfg feature = "testing", que e' a default em Cargo.toml):
    //  se o parse falhar (conta mock, como nos testes deste programa),
    //  usa um seed determinístico fixo pra permitir `anchor test` sem
    //  oraculo real. NUNCA deve rodar em producao.
    // =========================================================

    #[cfg(not(feature = "testing"))]
    {
        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account_data.data.borrow()
        ).map_err(|_| {
            msg!("ERROR: Switchboard account parse failed");
            MegabytError::InvalidDrawState
        })?;

        seed = get_randomness_with_tolerance(&randomness_data, clock.slot).map_err(|e| {
            msg!("ERROR: VRF not fulfilled yet. Wait for oracle.");
            e
        })?;

        msg!("seed={:?}", &seed[..8]);
    }

    #[cfg(feature = "testing")]
    {
        seed = match RandomnessAccountData::parse(
            ctx.accounts.randomness_account_data.data.borrow()
        ) {
            Ok(randomness_data) => {
                match get_randomness_with_tolerance(&randomness_data, clock.slot) {
                    Ok(vrf_seed) => {
                        msg!("VRF slot atual OK (testing mode)");
                        vrf_seed
                    }
                    Err(_) => {
                        msg!("VRF not fulfilled, using deterministic test seed");
                        let mut s = [0u8; 32];
                        for i in 0..32 { s[i] = (i as u8).wrapping_add(1); }
                        s
                    }
                }
            }
            Err(_) => {
                msg!("Switchboard parse failed, using deterministic test seed");
                let mut s = [0u8; 32];
                for i in 0..32 { s[i] = (i as u8).wrapping_add(1); }
                s
            }
        };
    }

    let monthly_draw = &mut ctx.accounts.monthly_draw;

    let numbers = generate_unique_numbers(&seed, monthly_draw.numbers_count);
    let crypto = unbiased_byte(&seed, 10, 0) + 1; // 1..=10 sem modulo bias

    monthly_draw.result_numbers = numbers.clone();
    monthly_draw.result_crypto = crypto;
    monthly_draw.random_seed = seed;
    monthly_draw.randomness_fulfilled = true;

    // Zera os contadores por tier — redundante com open_monthly_draw
    // (que ja zera na criacao), mas explicito, igual ao close_draw.rs.
    monthly_draw.monthly_winner_counts = [0; 10];

    // Tier 0 = jackpot inteiro, ainda nao dividido pelos ganhadores.
    monthly_draw.monthly_prize_per_tier[0] = monthly_draw.jackpot_pool;

    // Tiers 1..9 = cascade_pool fatiado pelos pesos renormalizados.
    let cascade_pool = monthly_draw.cascade_pool;
    for i in 0..9usize {
        let tier = i + 1;
        monthly_draw.monthly_prize_per_tier[tier] = cascade_pool
            .checked_mul(MONTHLY_CASCADE_TIER_BPS[i])
            .ok_or(MegabytError::MathOverflow)?
            .checked_div(MONTHLY_CASCADE_BPS_SUM)
            .ok_or(MegabytError::MathOverflow)?;
    }

    monthly_draw.status = 1;

    msg!("MONTHLY DRAW CLOSED");
    msg!("monthly_id={}", monthly_draw.id);
    msg!("numbers={:?}", numbers);
    msg!("crypto={}", crypto);
    msg!("jackpot_pool={}", monthly_draw.jackpot_pool);
    msg!("monthly_prize_per_tier={:?}", monthly_draw.monthly_prize_per_tier);

    Ok(())
}

#[derive(Accounts)]
pub struct CloseMonthlyDraw<'info> {
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

    /// CHECK: conta de randomness da Switchboard; validada contra monthly_draw.randomness_account
    pub randomness_account_data: AccountInfo<'info>,
}
