use anchor_lang::prelude::*;

#[constant]
pub const SEED: &str = "anchor";

// ===== CRYPTO IDS =====
pub const CRYPTO_BYTI: u8 = 1;
pub const CRYPTO_BTC: u8 = 2;
pub const CRYPTO_ETH: u8 = 3;
pub const CRYPTO_USDT: u8 = 4;
pub const CRYPTO_BNB: u8 = 5;
pub const CRYPTO_XRP: u8 = 6;
pub const CRYPTO_USDC: u8 = 7;
pub const CRYPTO_SOL: u8 = 8;
pub const CRYPTO_TRX: u8 = 9;
pub const CRYPTO_DOGE: u8 = 10;

// ===== PHASE SYSTEM =====
// 10 levels of emission + game expansion
// Each phase requires a minimum number of active users (wallets with 2+ tickets)

pub const MAX_PHASES: u8 = 10;

pub struct PhaseConfig {
    pub required_active_users: u64,
    pub supply_to_release: u64,
    pub cumulative_supply: u64,
    pub max_numbers: u8,      // range of selectable numbers (1..=max_numbers)
    pub numbers_per_ticket: u8, // how many numbers per ticket
    pub max_cryptos: u8,      // how many crypto predictions per ticket
}

pub const PHASE_CONFIG: [PhaseConfig; 10] = [
    // Level 1: Genesis
    PhaseConfig {
        required_active_users: 0,
        supply_to_release: 10_000,
        cumulative_supply: 10_000,
        max_numbers: 72,
        numbers_per_ticket: 6,
        max_cryptos: 1,
    },
    // Level 2: Spark
    PhaseConfig {
        required_active_users: 500,
        supply_to_release: 90_000,
        cumulative_supply: 100_000,
        max_numbers: 72,
        numbers_per_ticket: 6,
        max_cryptos: 2,
    },
    // Level 3: Wave
    PhaseConfig {
        required_active_users: 2_500,
        supply_to_release: 900_000,
        cumulative_supply: 1_000_000,
        max_numbers: 72,
        numbers_per_ticket: 7,
        max_cryptos: 2,
    },
    // Level 4: Pulse
    PhaseConfig {
        required_active_users: 10_000,
        supply_to_release: 9_000_000,
        cumulative_supply: 10_000_000,
        max_numbers: 72,
        numbers_per_ticket: 8,
        max_cryptos: 2,
    },
    // Level 5: Surge
    PhaseConfig {
        required_active_users: 50_000,
        supply_to_release: 90_000_000,
        cumulative_supply: 100_000_000,
        max_numbers: 72,
        numbers_per_ticket: 10,
        max_cryptos: 3,
    },
    // Level 6: Flow
    PhaseConfig {
        required_active_users: 200_000,
        supply_to_release: 400_000_000,
        cumulative_supply: 500_000_000,
        max_numbers: 72,
        numbers_per_ticket: 12,
        max_cryptos: 3,
    },
    // Level 7: Storm
    PhaseConfig {
        required_active_users: 500_000,
        supply_to_release: 1_000_000_000,
        cumulative_supply: 1_500_000_000,
        max_numbers: 72,
        numbers_per_ticket: 15,
        max_cryptos: 4,
    },
    // Level 8: Thunder
    PhaseConfig {
        required_active_users: 1_500_000,
        supply_to_release: 2_000_000_000,
        cumulative_supply: 3_500_000_000,
        max_numbers: 72,
        numbers_per_ticket: 18,
        max_cryptos: 4,
    },
    // Level 9: Orbit
    PhaseConfig {
        required_active_users: 5_000_000,
        supply_to_release: 3_000_000_000,
        cumulative_supply: 6_500_000_000,
        max_numbers: 72,
        numbers_per_ticket: 22,
        max_cryptos: 5,
    },
    // Level 10: Mega
    PhaseConfig {
        required_active_users: 10_000_000,
        supply_to_release: 3_500_000_000,
        cumulative_supply: 10_000_000_000,
        max_numbers: 72,
        numbers_per_ticket: 25,
        max_cryptos: 5,
    },
];

/// Get current phase config (0-indexed, phase 1 = index 0)
pub fn get_phase_config(phase: u64) -> &'static PhaseConfig {
    let idx = if phase == 0 { 0 } else { (phase - 1) as usize };
    let idx = std::cmp::min(idx, 9);
    &PHASE_CONFIG[idx]
}
