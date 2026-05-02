# MegaByt Protocol — Hackathon Pitch Kit (Final)

---

## HOOK (1 linha)

**EN:** "MegaByt: the lottery where the house doesn't win. 80% back to players. Math, not luck."

**PT:** "MegaByt: a loteria onde a banca nao ganha. 80% volta pros jogadores. Matematica, nao sorte."

---

## PITCH 30 SEGUNDOS (EN)

> MegaByt is a fully on-chain lottery protocol on Solana.
> Players buy tickets with BYTI. Prizes are paid in USDT.
> Every draw uses Switchboard VRF — verifiable randomness, zero manipulation.
> 80% of the pool goes back to winners across 10 prize tiers.
> Prizes below $1? Redistributed to the monthly jackpot — no dust payouts.
> Referral on-chain: invite 2 friends, get a free ticket.
> 200+ tickets tested on devnet. Full E2E pipeline automated.
> MegaByt. Provably fair. Fully on-chain.

---

## PITCH 30 SEGUNDOS (PT-BR)

> MegaByt e um protocolo de loteria 100% on-chain na Solana.
> Jogadores compram tickets com BYTI. Premios pagos em USDT.
> Cada sorteio usa VRF da Switchboard — aleatoriedade verificavel, zero manipulacao.
> 80% do pool volta pros ganhadores em 10 faixas de premio.
> Premio menor que $1? Vai pro jackpot mensal — ninguem recebe esmola.
> Referral on-chain: indica 2 amigos, ganha 1 ticket gratis.
> 200+ tickets testados na devnet. Pipeline E2E completo e automatizado.
> MegaByt. Provadamente justo. 100% on-chain.

---

## TWEET THREAD (X / TWITTER)

**Tweet 1:**
Introducing MegaByt Protocol

The first fully on-chain lottery on Solana where 80% goes back to players.

No house edge. No trust. Just math.

Thread (1/6)

**Tweet 2:**
How it works:

- Buy tickets with $BYTI
- 6 numbers + 1 crypto prediction
- VRF randomness (Switchboard) — impossible to manipulate
- 10 prize tiers from jackpot to 2 matches
- Prizes in $USDT

(2/6)

**Tweet 3:**
Smart tokenomics:

- 60% daily prize pool
- 15% monthly jackpot reserve
- 10% security
- 5% referrals
- 5% admin
- 5% infrastructure

Every token tracked on-chain.

(3/6)

**Tweet 4:**
No dust payouts.

If a tier prize is below $1 per winner, the entire pool rolls into the monthly jackpot.

Your money compounds. Never wasted.

(4/6)

**Tweet 5:**
Referral on-chain:

- 5% of each referred ticket goes to the referrer
- Invite 2 friends who buy tickets = 1 free ticket
- All tracked on-chain. Transparent. Viral.

(5/6)

**Tweet 6:**
Built on Solana. Anchor smart contracts.
Switchboard VRF. Multi-ticket per user.
200+ tickets E2E tested on devnet.

Provably fair. Fully on-chain.

Follow @MegaBytProtocol for updates.

(6/6)

---

## DESCRICAO CURTA (GitHub / Discord)

**EN:**
MegaByt is a fully on-chain lottery protocol on Solana. Players pick 6 numbers and a crypto prediction. Draws use Switchboard VRF for verifiable randomness. 80% of funds return to winners across 10 tiers. Prizes below $1 roll into a monthly jackpot. On-chain referral system with 5% payouts and bonus tickets. Built with Anchor. Tested with 200+ tickets on devnet.

**PT:**
MegaByt e um protocolo de loteria 100% on-chain na Solana. Jogadores escolhem 6 numeros e uma predicao de crypto. Sorteios usam VRF da Switchboard para aleatoriedade verificavel. 80% dos fundos voltam aos ganhadores em 10 faixas. Premios abaixo de $1 acumulam no jackpot mensal. Sistema de referral on-chain com 5% de payout e tickets bonus. Construido com Anchor. Testado com 200+ tickets na devnet.

---

## DIFERENCIAIS (para juiz)

| # | Diferencial | Impacto |
|---|---|---|
| 1 | VRF real (Switchboard) | Impossivel manipular |
| 2 | 10 tiers com cascata | Complexidade real de loteria |
| 3 | Regra de minimo $1 | Sem "esmola" — valores pequenos acumulam |
| 4 | Settlement em batch | Escala para centenas de tickets |
| 5 | Referral on-chain 5% | Growth loop viral |
| 6 | Bonus ticket (2 indicacoes) | Retencao real |
| 7 | Multi-ticket por user | UX de produto real |
| 8 | Dual token (BYTI/USDT) | Utility + valor estavel |
| 9 | Monthly jackpot | Acumula ao longo do tempo |
| 10 | 200+ tickets testados devnet | Prova real, nao demo fake |

---

## EXPLICACAO TECNICA (para dev/juiz tecnico)

**Stack:** Solana + Anchor + Switchboard VRF
**Program ID:** 2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS

**Fluxo:**
1. `open_draw` — admin abre rodada com duracao
2. `buy_ticket` — user compra N tickets (multi-ticket via UserDrawState)
3. `request_randomness` — registra conta VRF
4. `fulfill_randomness` / Switchboard callback — seed entregue
5. `close_draw` — gera 6 numeros + crypto a partir da seed
6. `settle_tickets` — processa tickets em batch via remainingAccounts
7. `finalize_payouts` — cascata + minimo $1 + residuos pro mensal
8. `pay_winners_batch` — paga cada winner individualmente via vault PDA

**Contas:**
- GlobalState (PDA) — configuracao global
- Draw (PDA) — estado de cada rodada
- Ticket (PDA) — ticket individual com index
- UserDrawState (PDA) — contador de tickets por user/draw
- UserState (PDA) — referral + bonus credits

**Seguranca:**
- VRF obrigatorio (dual mode: test + producao)
- Anti-replay em randomness
- ticket.exit() para persistencia
- Regra de minimo $1 contra dust
- Anti-self-referral
- Settlement com cap de tickets_processed

---

## EXPLORER PROOF

- Draw #20 (E2E validated): https://explorer.solana.com/address/2fzv7tuN23e1t2m9kAE84LmwpYfdYjLCB3fT3GU1Mx8q?cluster=devnet
- Draw #19 (200 tickets stress): https://explorer.solana.com/address/9UptnV2FKNXbSanzZmRgU8z9XzthPpULx4AZn9pHp4yF?cluster=devnet
- Program: https://explorer.solana.com/address/2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS?cluster=devnet
