use anchor_lang::prelude::*;

#[error_code]
pub enum MegabytError {
    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Invalid admin")]
    InvalidAdmin,

    #[msg("Invalid treasury")]
    InvalidTreasury,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Draw is still open")]
    DrawStillOpen,

    #[msg("Draw already closed")]
    DrawAlreadyClosed,

    #[msg("Draw closed")]
    DrawClosed,

    #[msg("Draw not ready for payout")]
    DrawNotReady,

    #[msg("Draw has not reached end time yet")]
    DrawNotEnded,

    #[msg("Invalid draw state")]
    InvalidDrawState,

    #[msg("Invalid duration")]
    InvalidDuration,

    #[msg("No tickets sold")]
    NoTicketsSold,

    #[msg("Invalid number")]
    InvalidNumber,

    #[msg("Invalid numbers")]
    InvalidNumbers,

    #[msg("Invalid numbers count for current phase")]
    InvalidNumbersCount,

    #[msg("Duplicate number")]
    DuplicateNumber,

    #[msg("Invalid crypto number")]
    InvalidCryptoNumber,

    #[msg("Invalid ticket")]
    InvalidTicket,

    #[msg("Ticket not settled")]
    TicketNotSettled,

    #[msg("Ticket already settled")]
    TicketAlreadySettled,

    #[msg("Ticket already paid")]
    TicketAlreadyPaid,

    #[msg("Settlement not complete")]
    SettlementNotComplete,

    #[msg("Settlement already finalized")]
    SettlementAlreadyFinalized,

    #[msg("Invalid token owner")]
    InvalidTokenOwner,

    #[msg("Invalid token mint")]
    InvalidMint,

    #[msg("Invalid vault authority")]
    InvalidVaultAuthority,

    #[msg("Invalid prize vault")]
    InvalidPrizeVault,

    #[msg("Invalid tier")]
    InvalidTier,

    #[msg("Randomness not fulfilled yet")]
    RandomnessNotReady,

    // === REFERRAL ERRORS ===

    #[msg("Referrer already set")]
    ReferrerAlreadySet,

    #[msg("Invalid referrer")]
    InvalidReferrer,

    #[msg("Self-referral not allowed")]
    SelfReferralNotAllowed,

    #[msg("User state not initialized")]
    UserStateNotInitialized,

    #[msg("Referrer state not initialized")]
    ReferrerStateNotInitialized,

    #[msg("Referral token account invalid")]
    ReferralTokenAccountInvalid,

    #[msg("Referral already counted for this user")]
    ReferralAlreadyCounted,

    #[msg("No bonus ticket credits available")]
    NoBonusTicketCredits,

    // === PHASE SYSTEM ERRORS ===

    #[msg("Maximum phase already reached")]
    MaxPhaseReached,

    #[msg("Active users threshold not met for next phase")]
    PhaseThresholdNotMet,

    #[msg("Supply cap exceeded for current phase")]
    SupplyCapExceeded,

    #[msg("Too many numbers for current phase")]
    TooManyNumbers,

    #[msg("Too many crypto selections for current phase")]
    TooManyCryptos,

    // === MONTHLY DRAW ERRORS ===

    #[msg("Invalid monthly draw range (empty, too large, gap, overlap or duplicate)")]
    InvalidMonthlyRange,

    #[msg("Invalid monthly vault")]
    InvalidMonthlyVault,
}
