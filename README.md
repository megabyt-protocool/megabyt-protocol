<div align="center">

# MegaByt Protocol

### Verifiable Value Redistribution on Solana

*Fully on-chain. Zero custody. Provably fair.*

> **⚡ Verify the protocol right now** — no trust required:
> ```bash
> ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
> ANCHOR_WALLET=~/.config/solana/id.json \
> npx ts-node --transpile-only scripts/audit-summary.ts
> ```

[![Solana](https://img.shields.io/badge/Solana-9945FF?style=flat-square&logo=solana&logoColor=white)](https://solana.com)
[![Anchor](https://img.shields.io/badge/Anchor_Framework-2F855A?style=flat-square&logo=rust&logoColor=white)](https://www.anchor-lang.com/)
[![Switchboard VRF](https://img.shields.io/badge/Switchboard_VRF-FF6B35?style=flat-square)](https://switchboard.xyz)
[![Devnet](https://img.shields.io/badge/Devnet-Live-00C9A7?style=flat-square)](#quick-start)
[![Tests](https://img.shields.io/badge/E2E_Validated-600+_tickets-3B82F6?style=flat-square)](#validated-draws)
[![License](https://img.shields.io/badge/MIT-License-gray?style=flat-square)](LICENSE)

**[Explorer](https://explorer.solana.com/address/2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS?cluster=devnet)** · **[Architecture](#architecture)** · **[Quick Start](#quick-start)** · **[Verification](#verifiable-randomness)** · **[Tokenomics](#tokenomics)**

</div>

---

## The Problem

Traditional redistribution systems are opaque. Participants trust operators to generate fair outcomes, manage funds honestly, and distribute rewards correctly. There is no way to verify any of it.

**MegaByt eliminates all trust assumptions.**

Every draw runs as a deterministic state machine on Solana. Randomness comes from Switchboard VRF with cryptographic proof. Fund custody is 100% programmatic. And anyone — participant, auditor, or judge — can call `verify_randomness_proof` to mathematically prove a draw was fair.

```
Program ID: 2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS (Devnet)
```

---

## How It Works

```
open_draw → buy_ticket (×N) → request_randomness → close_draw
                                                        ↓
                              pay_winners ← finalize ← settle_tickets
```

| Step | Instruction | What happens |
|:---:|---|---|
| 1 | `open_draw` | Admin opens round with configurable duration |
| 2 | `buy_ticket` | Participants select 6 numbers (1–72) + 1 crypto (1–10) |
| 3 | `request_randomness` | Switchboard VRF account registered with commit-slot binding |
| 4 | `close_draw` | VRF seed consumed → 6 result numbers + crypto derived on-chain |
| 5 | `settle_tickets` | Batch classification into 10 prize tiers |
| 6 | `finalize_payouts` | Linear cascade + anti-dust rule + monthly rollover |
| 7 | `pay_winners_batch` | Individual token transfers to each winner |

Multi-ticket supported: each user can buy multiple tickets per draw via `UserDrawState` counter.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     MegaByt Program                       │
│                                                           │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────────┐   │
│  │ GlobalState  │  │   Draw   │  │      Ticket       │   │
│  │ ─────────── │  │ ──────── │  │ ───────────────── │   │
│  │ admin       │  │ id       │  │ owner             │   │
│  │ ticket_price│  │ status   │  │ numbers [u8; 6]   │   │
│  │ total_users │  │ pool     │  │ crypto            │   │
│  │ monthly_pool│  │ seed     │  │ tier              │   │
│  │ phase       │  │ results  │  │ prize_amount      │   │
│  └─────────────┘  └──────────┘  └───────────────────┘   │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  UserState   │  │ UserDrawState │  │ VaultAuthority │  │
│  │ (referral)   │  │ (multi-tkt)   │  │ (PDA signer)   │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**PDA Derivation:**

| Account | Seeds |
|---|---|
| GlobalState | `["global-state-v3"]` |
| Draw | `["draw-v3", draw_id.to_le_bytes()]` |
| Ticket | `["ticket", draw_pda, user, ticket_index.to_le_bytes()]` |
| UserDrawState | `["user-draw", draw_pda, user]` |
| UserState | `["user-state-v3", user]` |
| VaultAuthority | `["vault-authority-v3"]` |

---

## Verifiable Randomness

MegaByt integrates [Switchboard VRF](https://switchboard.xyz) for cryptographic randomness.

**Three-layer verification:**

| Layer | What it proves |
|---|---|
| **Account binding** | VRF account matches the one registered in `request_randomness` |
| **Seed integrity** | On-chain seed equals the Switchboard oracle output |
| **Result reproducibility** | Re-executing `generate_unique_numbers(seed)` produces identical results |

```rust
// Anyone can call this — no admin key, no signer, permissionless
pub fn verify_randomness_proof(ctx: Context<VerifyRandomness>, draw_id: u64) -> Result<()>
```

**Dual mode:** production path parses real Switchboard VRF; test mode detects pre-filled seeds from `fulfill_randomness`. Both paths verify result reproducibility.

### External verification

```bash
# Verify any completed draw — no special permissions needed
DRAW_ID=35 npx ts-node --transpile-only scripts/verify-draw.ts
```

Output includes on-chain proof, off-chain re-derivation, seed SHA256 fingerprint, and Solana Explorer link.

---

## Tokenomics

### Per-Draw Distribution

| Allocation | Share | Purpose |
|---|:---:|---|
| Prize Pool | 60% | Distributed across 10 tiers to winners |
| Monthly Reserve | 15% | Accumulates for monthly jackpot |
| Security Fund | 10% | Protocol security and insurance |
| Referral Rewards | 5% | Paid to referrers on-chain |
| Administration | 5% | Operations |
| Infrastructure | 5% | Running costs |

### Prize Tiers

Prizes cascade linearly: if a tier has zero winners, its entire pool drops to the next tier below. Prizes under $1 USDT per winner move to the monthly jackpot (anti-dust rule).

| Tier | Condition | Pool Share |
|:---:|---|:---:|
| 0 | 6 numbers + crypto | 55.0% |
| 1 | 6 numbers | 12.0% |
| 2 | 5 numbers + crypto | 8.0% |
| 3 | 5 numbers | 6.0% |
| 4 | 4 numbers + crypto | 5.0% |
| 5 | 4 numbers | 4.0% |
| 6 | 3 numbers + crypto | 3.0% |
| 7 | 3 numbers | 3.0% |
| 8 | 2 numbers + crypto | 2.5% |
| 9 | 2 numbers | 1.5% |

### Referral System

On-chain referral with zero trust assumptions:

- **5%** of each referred ticket goes directly to referrer's token account
- After **2 successful referrals** → 1 free bonus ticket (via `claim_bonus_ticket`)
- Anti-self-referral enforced at program level
- All referral state tracked per-user on-chain

### BYTI Emission (10 Phases)

Token supply is gated by **proven on-chain adoption** — no tokens are released without real active users.

| Phase | Name | Config | Users Required | Supply Released | Cumulative |
|:---:|---|---|---:|---:|---:|
| 1 | Genesis | 6 num + 1 crypto | 0 | 10K | 10K |
| 2 | Spark | 6 + 2 | 500 | 90K | 100K |
| 3 | Wave | 7 + 2 | 2,500 | 900K | 1M |
| 4 | Pulse | 8 + 2 | 10,000 | 9M | 10M |
| 5 | Surge | 10 + 3 | 50,000 | 90M | 100M |
| 6 | Flow | 12 + 3 | 200,000 | 400M | 500M |
| 7 | Storm | 15 + 4 | 500,000 | 1B | 1.5B |
| 8 | Thunder | 18 + 4 | 1,500,000 | 2B | 3.5B |
| 9 | Orbit | 22 + 5 | 5,000,000 | 3B | 6.5B |
| 10 | Mega | 25 + 5 | 10,000,000 | 3.5B | 10B |

Total supply: **10,000,000,000 BYTI** — 85% exists only if the protocol reaches millions of users.

---

## Validated Draws

End-to-end validated on Solana devnet with real transactions:

| Draw | Tickets | Strategy | Winners | Duration | SOL Cost | Status |
|:---:|:---:|---|:---:|---:|---:|:---:|
| #19 | 200 | 200 wallets × 1 | 24 | 12m 09s | 2.01 | ✅ Paid |
| #27 | 300 | 60 wallets × 5 | 23 | 10m 39s | 4.63 | ✅ Paid |
| #32 | 50 | 10 wallets × 5 | 2 | — | — | ✅ Paid |
| #35 | 600 | 120 wallets × 5 | 35 | 23m 35s | ~8.0 | ✅ Paid |

Every draw verified: settlement complete, cascade correct, anti-dust triggered, winners paid, monthly pool accumulating.

---

## Security

| Protection | Implementation | Status |
|---|---|:---:|
| Reentrancy | Anchor single-instruction model | ✅ |
| PDA collisions | Unique seeds with ticket index | ✅ |
| Integer overflow | `checked_*` arithmetic throughout | ✅ |
| Double payment | `ticket.paid` flag + `require!(!paid)` | ✅ |
| Double settlement | `ticket.settled` + `ticket.exit()` | ✅ |
| Vault authority | PDA-derived signer with seed constraints | ✅ |
| VRF replay | `require!(!randomness_requested)` + commit-slot | ✅ |
| Self-referral | Program-level validation in `set_referrer` | ✅ |
| Settlement overflow | `tickets_processed <= tickets_sold` cap | ✅ |
| Admin recovery | `reset_draw_settlement` for stuck draws | ✅ |
| External audit | Planned post-hackathon | ⏳ |

---

## Quick Start

### Prerequisites

- **Rust** + Cargo
- **Solana CLI** 1.18+
- **Anchor** 0.30+
- **Node.js** 20+

### Build & Deploy

```bash
git clone https://github.com/your-username/megabyt.git
cd megabyt
npm install

solana config set --url devnet
anchor build
anchor deploy --provider.cluster devnet
```

### Run a Draw

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=~/.config/solana/id.json

# Quick 20-ticket E2E test
TICKETS=20 MULTI=5 npx ts-node --transpile-only scripts/flow-master-final.ts

# Full stress test with checkpoint/resume
npx ts-node --transpile-only scripts/flow-1000-devnet.ts

# Verify the draw
DRAW_ID=36 npx ts-node --transpile-only scripts/verify-draw.ts
```

### Available Scripts

| Script | Purpose |
|---|---|
| `audit-summary.ts` | **Live protocol health** — global state, recent draws, integrity checks |
| `verify-draw.ts` | On-chain + off-chain randomness verification for any draw |
| `flow-master-final.ts` | Parametric E2E pipeline (any ticket count) |
| `flow-1000-devnet.ts` | 1000-ticket stress test with checkpoint/resume |
| `check-1000-budget.ts` | Pre-flight SOL + token balance check |
| `simulate-tokenomics.ts` | Economic model simulation |
| `test-referral.ts` | Referral system validation |
| `audit-draw.ts` | Per-draw ticket audit with snapshot comparison |

---

## Project Structure

```
megabyt/
├── programs/megabyt/src/
│   ├── lib.rs                         # 17 instructions
│   ├── state.rs                       # Account structs
│   ├── error.rs                       # 30+ error codes
│   ├── constants.rs                   # 10-phase config
│   └── instructions/
│       ├── initialize.rs              # Program setup
│       ├── initialize_vaults.rs       # Token vault creation
│       ├── open_draw.rs               # Round lifecycle
│       ├── buy_ticket.rs              # Multi-ticket purchase
│       ├── buy_ticket_with_referral.rs
│       ├── request_randomness.rs      # VRF registration
│       ├── fulfill_randomness.rs      # Test mode seeding
│       ├── close_draw.rs              # Result generation
│       ├── settle_tickets.rs          # Batch classification
│       ├── finalize_payouts.rs        # Cascade + anti-dust
│       ├── pay_winners_batch.rs       # Prize distribution
│       ├── verify_randomness.rs       # Permissionless proof
│       ├── init_user_state.rs         # Referral PDA
│       ├── set_referrer.rs            # Referrer registration
│       ├── claim_bonus_ticket.rs      # Referral rewards
│       ├── advance_phase.rs           # Phase progression
│       └── reset_draw_settlement.rs   # Admin recovery
├── scripts/
│   ├── audit-summary.ts               # Live protocol health audit
│   ├── audit-draw.ts                  # Per-draw ticket audit
│   ├── verify-draw.ts                 # Randomness proof verification
│   ├── flow-master-final.ts           # Parametric E2E pipeline
│   ├── flow-1000-devnet.ts            # 1000-ticket stress test
│   ├── check-1000-budget.ts           # Pre-flight budget check
│   ├── simulate-tokenomics.ts         # Economic simulation
│   ├── test-referral.ts               # Referral flow test
│   └── ...                            # Recovery & utility scripts
├── tests/megabyt.ts                   # 10/10 Anchor tests
├── frontend/index.html                # Wallet-connected demo
├── demo/index.html                    # Hackathon presentation
└── target/idl/megabyt.json            # Generated IDL
```

---

## Competitive Advantage

| | |
|---|---|
| **Verifiable fairness** | `verify_randomness_proof` — anyone can prove any draw is fair, on-chain |
| **Adoption-gated supply** | BYTI emission requires real users, not calendar dates |
| **On-chain referral** | Viral growth with programmatic 5% payouts + bonus tickets |
| **Composable infrastructure** | Other Solana protocols can integrate MegaByt as a redistribution layer |
| **Historical trust** | Every completed draw is permanent, auditable proof of fairness |

---

## Roadmap

- [x] Core protocol (17 instructions)
- [x] Switchboard VRF integration
- [x] Multi-ticket per user
- [x] On-chain referral system
- [x] 10-phase emission plan
- [x] Permissionless verification (`verify_randomness_proof`)
- [x] 600+ ticket stress test validated
- [ ] Web interface (React + Phantom)
- [ ] 1000-ticket stress test
- [ ] Mainnet deployment
- [ ] External security audit
- [ ] DAO governance

---

## License

MIT © 2025–2026 MegaByt Protocol

---

<div align="center">

*"This system redistributes value using verifiable randomness — fully on-chain, no custody, no black box."*

**[View on Solana Explorer →](https://explorer.solana.com/address/2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS?cluster=devnet)**

</div>
