use anchor_lang::prelude::*;

#[account]
pub struct GlobalState {
    pub admin: Pubkey,
    pub treasury: Pubkey,

    pub token_mint: Pubkey,
    pub byti_mint: Pubkey,
    pub usdt_mint: Pubkey,

    pub ticket_price: u64,
    pub total_users: u64,
    pub active_users: u64,
    pub total_collected: u64,
    pub total_draws: u64,
    pub current_draw_id: u64,
    pub total_volume_byti: u64,
    pub total_revenue_usdt: u64,

    pub total_supply_cap: u64,
    pub released_supply: u64,
    pub current_phase: u64,
    pub current_phase_supply: u64,

    pub numbers_count: u8,
    pub crypto_count: u8,

    pub prize_vault: Pubkey,
    pub treasury_vault: Pubkey,
    pub legal_vault: Pubkey,
    pub marketing_vault: Pubkey,
    pub liquidity_vault: Pubkey,

    pub byti_ticket_vault: Pubkey,
    pub byti_treasury_vault: Pubkey,
    pub byti_emission_vault: Pubkey,
    pub usdt_reserve_vault: Pubkey,
    pub prize_usdt_vault: Pubkey,
    pub referral_usdt_vault: Pubkey,
    pub legal_usdt_vault: Pubkey,
    pub ops_usdt_vault: Pubkey,
    pub admin_usdt_vault: Pubkey,

    // ===== CONTROLE FINANCEIRO / MONTHLY =====
    pub monthly_pool: u64,
    pub monthly_cycle_start: i64,
    pub monthly_cycle_duration: i64,
    pub last_monthly_rollover_at: i64,
    pub monthly_cycles_completed: u64,

    pub admin_total: u64,
    pub security_total: u64,
    pub referral_total: u64,
    pub costs_total: u64,
    pub monthly_total: u64,
    pub daily_total: u64,
}

impl GlobalState {
    pub const LEN: usize = 8
        + 32 + 32
        + 32 + 32 + 32
        + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8
        + 8 + 8 + 8 + 8
        + 1 + 1
        + 32 + 32 + 32 + 32 + 32
        + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32
        + 8 + 8 + 8 + 8 + 8
        + 8 + 8 + 8 + 8 + 8 + 8;
}

#[account]
pub struct Draw {
    pub id: u64,

    pub is_open: bool,
    pub is_closed: bool,
    pub is_paid: bool,
    pub settled: bool,

    pub start_time: i64,
    pub end_time: i64,

    pub total_tickets: u64,
    pub total_amount: u64,
    pub total_collected: u64,
    pub total_pool: u64,
    pub prize_pool: u64,
    pub tickets_sold: u64,

    pub winner: Pubkey,

    pub crypto_number: u8,
    pub result_numbers: Vec<u8>,
    pub result_crypto: u8,

    pub winning_numbers: Vec<u8>,
    pub winning_crypto: u8,

    // VRF real
    pub randomness_account: Pubkey,
    pub commit_slot: u64,

    pub random_seed: [u8; 32],
    pub randomness_requested: bool,
    pub randomness_fulfilled: bool,

    pub tickets_processed: u64,
    pub tickets_paid: u64,
    pub winner_counts: [u64; 10],
    pub prize_per_tier: [u64; 10],
    pub settlement_complete: bool,

    pub status: u8,

    pub bump: u8,

    // ===== NEW: MONTHLY ROLLOVER =====
    /// Total amount from this draw sent to monthly accumulator
    /// (residuals from division + tiers below 1 USDT minimum)
    pub monthly_rollover_contribution: u64,

    // ===== PHASE CONFIG =====
    /// Number of numbers per ticket for this draw (from phase config)
    pub numbers_count: u8,
}

impl Draw {
    pub const MAX_NUMBERS: usize = 25;

    /// O sorteio sempre tira DRAWN_NUMBERS (6) numeros — result_numbers e
    /// winning_numbers tem tamanho fixo, independente da fase. A cartela
    /// (Ticket) e' dimensionada a' parte por numbers_count.
    pub fn len() -> usize {
        let drawn = crate::constants::DRAWN_NUMBERS as usize;
        8  // discriminator
        + 8     // id
        + 1 + 1 + 1 + 1  // bools
        + 8 + 8           // times
        + 8 + 8 + 8 + 8 + 8 + 8  // amounts
        + 32    // winner
        + 1     // crypto_number
        + 4 + drawn  // result_numbers Vec
        + 1     // result_crypto
        + 4 + drawn  // winning_numbers Vec
        + 1     // winning_crypto
        + 32 + 8          // randomness account + commit_slot
        + 32              // random_seed
        + 1 + 1           // randomness bools
        + 8 + 8           // processed + paid
        + (8 * 10)        // winner_counts
        + (8 * 10)        // prize_per_tier
        + 1               // settlement_complete
        + 1               // status
        + 1               // bump
        + 8               // monthly_rollover_contribution
        + 1               // numbers_count
    }
}

#[account]
pub struct Ticket {
    pub owner: Pubkey,
    pub draw: Pubkey,
    pub draw_id: u64,

    pub numbers: Vec<u8>,
    pub crypto: u8,
    pub crypto_number: u8,

    pub claimed: bool,
    pub settled: bool,
    pub paid: bool,

    pub tier: u8,
    pub prize_amount: u64,

    pub bump: u8,

    // ===== NEW: MULTI-TICKET INDEX =====
    /// Sequential index of this ticket for the user in this draw
    pub ticket_index: u32,
}

impl Ticket {
    /// Dynamic length: 4 bytes for Vec length prefix + up to 25 bytes for numbers
    pub const MAX_NUMBERS: usize = 25;

    pub fn len(_owner: &Pubkey, _draw: &Pubkey, numbers_count: u8) -> usize {
        8  // discriminator
        + 32    // owner
        + 32    // draw
        + 8     // draw_id
        + 4 + (numbers_count as usize)  // Vec<u8>: 4 bytes length + data
        + 1     // crypto
        + 1     // crypto_number
        + 1     // claimed
        + 1     // settled
        + 1     // paid
        + 1     // tier
        + 8     // prize_amount
        + 1     // bump
        + 4     // ticket_index
    }
}

// ===== USER STATE FOR REFERRAL SYSTEM =====

#[account]
pub struct UserState {
    pub owner: Pubkey,
    pub referrer: Pubkey,
    pub has_referrer: bool,
    pub counted_as_referral_conversion: bool,
    pub successful_referrals: u32,
    pub total_referral_earned: u64,
    pub bonus_ticket_credits: u32,
    pub bump: u8,
}

impl UserState {
    pub const LEN: usize = 8
        + 32 + 32
        + 1 + 1
        + 4 + 8 + 4
        + 1;
}

// ===== NEW: USER DRAW STATE (MULTI-TICKET COUNTER) =====

#[account]
pub struct UserDrawState {
    /// The user wallet
    pub user: Pubkey,
    /// The draw this state belongs to
    pub draw: Pubkey,
    /// Number of tickets bought by this user in this draw
    pub tickets_bought: u32,
    /// PDA bump
    pub bump: u8,
}

impl UserDrawState {
    pub const LEN: usize = 8
        + 32    // user
        + 32    // draw
        + 4     // tickets_bought
        + 1;    // bump
}

// ===== USER GLOBAL STATE (UNIQUE USER COUNTER) =====
// PDA seeded by user key only — ensures total_users / active_users
// are incremented exactly once per wallet across all draws.

#[account]
pub struct UserGlobalState {
    /// The user wallet this state belongs to
    pub user: Pubkey,
    /// Whether this user has already been counted in global_state.total_users
    /// and global_state.active_users. Set to true on first ticket ever.
    pub counted_globally: bool,
    /// PDA bump
    pub bump: u8,
}

impl UserGlobalState {
    pub const LEN: usize = 8
        + 32    // user
        + 1     // counted_globally
        + 1;    // bump
}

// ===== SORTEIO MENSAL =====
// Etapa 2: so o estado (contas + layout). Sem logica de sorteio ainda —
// isso vem nas proximas etapas (open/close/settle/finalize/pay mensal).

/// Singleton com o estado global do sorteio mensal. Conta nova e separada
/// de GlobalState de proposito: GlobalState foi criado com `space` fixo
/// (sem realloc), entao adicionar campos nela exigiria uma migracao
/// arriscada do singleton ja em producao. Aqui nao ha esse problema.
#[account]
pub struct MonthlyState {
    /// Vault SPL dedicado ao pool mensal (ver plano: vault separado do
    /// prize_vault diario, alimentado por um sweep em close_draw numa
    /// etapa futura). Pubkey::default() ate init_monthly_vault rodar.
    pub monthly_vault: Pubkey,
    /// Id do ULTIMO sorteio mensal criado (0 = nenhum aberto ainda) — mesma
    /// semantica de global_state.current_draw_id (open_monthly_draw usa
    /// current_monthly_id + 1 como id do novo sorteio).
    pub current_monthly_id: u64,
    /// Quantos sorteios mensais ja foram concluidos.
    pub total_monthly_draws: u64,
    /// Espelho informativo do valor de jackpot (75%) que ja rolou pra
    /// meses seguintes por falta de acertador do numero maximo. A fonte
    /// de verdade financeira continua sendo global_state.monthly_pool;
    /// este campo e so pra visibilidade/auditoria.
    pub jackpot_carry: u64,
    pub last_monthly_open_at: i64,
    /// Ultimo draw_id (diario) ja coberto por algum sorteio mensal (0 =
    /// nenhum ainda). open_monthly_draw exige que o proximo range comece
    /// exatamente em last_covered_draw_id + 1 — impede gap ou sobreposicao
    /// entre meses consecutivos. So nao se aplica no primeiro mes (0).
    pub last_covered_draw_id: u64,
    pub bump: u8,
}

impl MonthlyState {
    pub const LEN: usize = 8
        + 32    // monthly_vault
        + 8 + 8 // current_monthly_id + total_monthly_draws
        + 8     // jackpot_carry
        + 8     // last_monthly_open_at
        + 8     // last_covered_draw_id
        + 1;    // bump
}

/// Um sorteio mensal individual. Cobre um intervalo de sorteios diarios
/// (`first_draw_id..=last_draw_id`) e reaproveita os tickets desses
/// sorteios, repontuando-os contra um resultado VRF proprio do mes.
#[account]
pub struct MonthlyDraw {
    pub id: u64,

    /// Intervalo de draw_id (diarios) cobertos por este sorteio mensal.
    pub first_draw_id: u64,
    pub last_draw_id: u64,

    /// Soma de tickets_sold das draws cobertas — meta de settlement.
    pub tickets_target: u64,
    pub tickets_processed: u64,
    pub tickets_paid: u64,

    /// Snapshot do global_state.monthly_pool no momento da abertura,
    /// ja dividido conforme a spec (75% jackpot / 25% cascata).
    pub pool_snapshot: u64,
    pub jackpot_pool: u64,
    pub cascade_pool: u64,

    pub numbers_count: u8,
    pub result_numbers: Vec<u8>,
    pub result_crypto: u8,

    pub randomness_account: Pubkey,
    pub commit_slot: u64,
    pub random_seed: [u8; 32],
    pub randomness_requested: bool,
    pub randomness_fulfilled: bool,

    /// Contadores por tier igual ao diario, mas restritos a este sorteio
    /// mensal (tier 0 = jackpot; 1..9 = cascata).
    pub monthly_winner_counts: [u64; 10],
    pub monthly_prize_per_tier: [u64; 10],

    pub jackpot_hit: bool,
    pub jackpot_winner_count: u64,
    /// Quanto voltou pro global_state.monthly_pool neste ciclo (jackpot
    /// nao reclamado + residuos + anti-esmola).
    pub rollover_to_next_month: u64,

    /// 0=aberto, 1=fechado/numeros derivados, 2=settled, 3=finalizado, 4=pago
    /// (mesma convencao de status usada em Draw).
    pub status: u8,
    pub bump: u8,
}

impl MonthlyDraw {
    pub const MAX_NUMBERS: usize = 25;

    /// Sorteio mensal tambem tira sempre DRAWN_NUMBERS (6) numeros.
    pub fn len() -> usize {
        let drawn = crate::constants::DRAWN_NUMBERS as usize;
        8   // discriminator
        + 8     // id
        + 8 + 8 // first_draw_id + last_draw_id
        + 8 + 8 + 8 // tickets_target + tickets_processed + tickets_paid
        + 8 + 8 + 8 // pool_snapshot + jackpot_pool + cascade_pool
        + 1     // numbers_count
        + 4 + drawn // result_numbers Vec
        + 1     // result_crypto
        + 32 + 8 // randomness_account + commit_slot
        + 32    // random_seed
        + 1 + 1 // randomness_requested + randomness_fulfilled
        + (8 * 10) // monthly_winner_counts
        + (8 * 10) // monthly_prize_per_tier
        + 1     // jackpot_hit
        + 8     // jackpot_winner_count
        + 8     // rollover_to_next_month
        + 1     // status
        + 1     // bump
    }
}

/// Registro de dedup + pagamento de UM ticket dentro de UM sorteio
/// mensal especifico. Existe pra nao precisar adicionar campos em Ticket
/// (o que quebraria a desserializacao de todos os tickets ja on-chain).
/// PDA sugerida: ["m-claim", monthly_draw, ticket] — o `init` da conta
/// falha se ja existir, o que da a deduplicacao "de graca" no settle
/// mensal (um ticket nao pode ser contado 2x mesmo se reenviado).
#[account]
pub struct MonthlyClaim {
    pub monthly_draw: Pubkey,
    pub ticket: Pubkey,
    /// Dono do ticket, cacheado aqui pra nao precisar redesserializar o
    /// ticket original na hora de pagar.
    pub owner: Pubkey,
    pub tier: u8,
    pub paid: bool,
    pub bump: u8,
}

impl MonthlyClaim {
    pub const LEN: usize = 8
        + 32 + 32 + 32 // monthly_draw + ticket + owner
        + 1     // tier
        + 1     // paid
        + 1;    // bump
}
