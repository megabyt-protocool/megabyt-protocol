# MegaByt — Progresso do Sorteio Mensal

> Checkpoint atualizado em **2026-09-10**.
> Branch de trabalho: `feature/monthly-draw-batch-pay` (no GitHub, **não** mergeada na `main`).
>
> ⚠️ **A PRÓXIMA SESSÃO COMEÇA PELA ETAPA 4 (última da correção do jogo, §3-B) —
> preço combinatório `C(n,6) × k` + multi-crypto.** Etapas 1, 2 e 3 já estão feitas
> e testadas (73 verdes). Falta só o preço variável por tamanho de cartela e a
> cartela poder escolher mais de 1 crypto — depois disso o jogo bate 100% com o
> que o dono quer.

---

## 1. O QUE ESTÁ FEITO ✅

### Código do ciclo mensal (branch `feature/monthly-draw-batch-pay`, tudo no GitHub)

- [x] **Etapa 1** — `pay_winners_batch` refatorado pra lote real via `remaining_accounts` (idempotente)
- [x] **Etapa 2** — `MonthlyState` / `MonthlyDraw` / `MonthlyClaim` + `init_monthly_state` + `init_monthly_vault`; `initialize.rs` corrigido pra gravar `monthly_cycle_duration` real
- [x] **3A** — `open_monthly_draw` (snapshot, split 75/25, sweep físico, contiguidade de range)
- [x] **3B** — `request_monthly_randomness` + `close_monthly_draw` + `randomness.rs` (paridade byte-a-byte c/ o diário)
- [x] **3C** — `settle_monthly_tickets` (lote, dedup via `MonthlyClaim`) + `scoring.rs`
- [x] **Crypto** — `crypto_count = 10` desde o `initialize` + `set_crypto_count` (admin, 1..10)
- [x] **3D** — `finalize_monthly_payouts` + `payouts.rs` (jackpot, cascata + anti-esmola, sweep-espelho, conservação)
- [x] **3E** — `pay_monthly_winners_batch` (lote real, idempotente, status 3→4)
- [x] **`cancel_monthly_draw`** — escape hatch de emergência (resolve o A-1 da auditoria, ver §3)
- [x] **`pay_winners_batch` admin-gated** — M-1 da auditoria resolvido (commit `65aa360`, ver §3-A)

**Ciclo mensal completo:** `open → request → close → settle → finalize → pay` (+ `cancel` no status 0).

### Correção do jogo — Etapas 1/2/3 de 4 (ver §3-B), commits `9f46b13`/`5f7c759`/`f1ec991`

- [x] **Etapa 1** — `resolve_tier` usa `deficit = 6 (DRAWN_NUMBERS) - hits`, nunca o tamanho da cartela. Diário e mensal consolidados numa fonte só (`scoring.rs`).
- [x] **Etapa 2** — sorteio sempre tira 6 números (`DRAWN_NUMBERS`), em qualquer fase, diário e mensal.
- [x] **Etapa 3** — cartela de tamanho variável (Opção A do plano: só os números variam nesta etapa; crypto e preço ficam pra Etapa 4):
  - `validate_numbers`: de "== numbers_count" (exato) para "6..=numbers_count" (teto por fase, não mais valor exato).
  - `Ticket::len()` sem parâmetro — aloca sempre o teto `MAX_NUMBERS=25`.
  - Nova instrução `set_numbers_count` (mirror de `set_crypto_count`, admin-gated, valida 6..=25).
  - Testes: unitários da validação (6/7/8/10/25 aceitos, 5/11/fora-de-range/duplicata rejeitados) + integração (`tests/set_numbers_count.ts`: compra por tamanho, admin-gating) + **bônus E2E fechando o loop com a Etapa 1**: cartela de 8 cobrindo os 6 sorteados + crypto certa vence o jackpot (tier 0) de verdade via `settle_tickets` on-chain.
  - `make test`: 66 → **73 passing** / 0 failing / 1 pending. `make test-rust`: 21 → **27 passing**.
- [ ] **Etapa 4 (próxima, última desta correção)** — preço combinatório `C(n,6) × k` + multi-crypto (ver §3-B, itens D/E consolidados).

### Build seguro por padrão ✅ (era o item 1 das pendências — RESOLVIDO em 2026-09-07)

- [x] `programs/megabyt/Cargo.toml`: **`default = []`** — `anchor build` cru = binário de produção (VRF Switchboard real, **sem** o fallback determinístico). A feature `testing` só liga o seed fixo pros testes.
- [x] `Makefile`: `make test` (roda `anchor test -- --features testing`) · `make test-rust` · `make build-prod` (build + verificação) · `make build-prod-verifiable` (docker) · `make idl`
- [x] `scripts/verify-no-testing.sh`: verificação objetiva do `.so` (marcadores de teste ausentes + caminho de produção presente). Testada dos dois lados.
- [x] `DEPLOY.md`: regra de ouro, fluxo de deploy passo a passo, como a verificação funciona, histórico.
- [x] `close_draw.rs` / `close_monthly_draw.rs`: `msg!` guard barulhento no bloco `#[cfg(feature = "testing")]`; removida a `msg!("Using Switchboard VRF (production path)")` que mentia em builds de teste; comentários contraditórios consolidados.
- **Nota:** o binário **na devnet ainda é o de teste** (buildado antes desta mudança). Trocar por um `make build-prod` antes de qualquer coisa séria (aí o fluxo diário/mensal via keypair-lixo para de funcionar → precisa de Switchboard On-Demand real).

### Testes

- [x] `make test` (`anchor test`): **66 passing / 0 failing / 1 pending**
- [x] `make test-rust` (`cargo test --lib`): **11 passing / 0 failing** (paridade `randomness`/`scoring`/`payouts` + jackpot)
- [x] Prova isolada "jackpot sem ganhador → cascata ainda paga" (Draw C em `tests/monthly_finalize_payouts.ts`)
- [x] `pay_winners_batch` admin-gated: teste "não-admin é rejeitado" em `tests/pay_winners_batch.ts`
- [x] `cancel_monthly_draw`: `tests/monthly_cz_cancel_draw.ts` (cancel no status 0 c/ conservação e rollback; rejeição em status 1/2/3/4; não-admin rejeitado)
- 1 pending: `init_monthly_vault rejeita mint diferente` — só roda em estado 100% limpo (conta singleton já existe na suíte)

### Devnet — programa `2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS`

- [x] **Upgrade do bytecode** (2026-09-05) — slot `493679424` (era `456737049` de 2026-04-20). Buildado **COM `testing`** (era o default na época). **Não inclui o `cancel_monthly_draw` nem a limpeza do build** — o código na devnet está atrás da branch.
- [x] **IDL publicado on-chain** — 25 instruções (a branch já tem 26)
- [x] `init_monthly_state` (`9rdexPKY…`), `init_monthly_vault` (`CW4Y9KBs…`), `set_crypto_count(10)` rodados
- [x] **Smoke test do ciclo completo** — monthly draw #1, range `[286, 287]`, conservação exata, as 2 regras (jackpot acumula / cascata paga sem jackpot) provadas rodando

### Chaves / infra devnet

| | pubkey | keypair | saldo aprox |
|---|---|---|---|
| Upgrade authority | `pxTedq6HYJ787byoh6Sh6t7YndsJFacJ99fjBqWjSnm` | `/mnt/c/Users/becke/temp.json` | ~34 SOL |
| Admin (`global_state.admin`) | `AueuFaAd9RYPdnc3aB3RmWPzni3XZiYUqoS3a1mgcvzb` | `~/.config/solana/id.json` | ~66 SOL |
| RPC | RPC devnet privado (Helius) — o público não aguenta o deploy | — | — |

---

## 2. AUDITORIA DE SEGURANÇA das partes novas ✅ (feita em 2026-09-07)

Escopo: 8 instruções mensais + `set_crypto_count` + refactor do `pay_winners_batch` + `randomness.rs` / `scoring.rs` / `payouts.rs`. Revisão adversarial, linha a linha.

**Resultado: 0 CRÍTICOS · 1 ALTO · 6 MÉDIOS · 7 BAIXOS.**

- 🔴 **Crítico: 0.** Conservação fecha em todos os caminhos (verificado matematicamente + rodando na devnet), vaults blindados (authority PDA, não substituível), dedup e anti-duplo-pagamento sólidos, aritmética toda `checked_*` com `overflow-checks = true`, máquina de estados impede pular fases.
- 🟠 **Alto: 1 — A-1** (sorteio mensal sem recuperação → brick permanente com fundos travados). **✅ RESOLVIDO** com `cancel_monthly_draw` (ver §3).
- 🟡 **Médio: 6** — **M-1 ✅ RESOLVIDO** (ver §3-A); M-2 a M-6 abertos (ver §4).
- 🟢 **Baixo: 7** (B-1 a B-7, ver §4).

> ⚠️ **Fora da auditoria de segurança, encontramos em 2026-09-08 um ERRO DE REGRA DE
> NEGÓCIO grave no coração do jogo (scoring de tier) — ver §3-B. Não é de segurança
> (não perde/rouba dinheiro), mas o jogo no código está diferente do que o dono quer.**

Paridade dos módulos compartilhados **confirmada byte-a-byte** vs as cópias privadas do diário (`scoring` vs `settle_tickets`, `randomness` vs `close_draw`, `payouts` vs `finalize_payouts`).

Preocupações de contexto (não achados formais): o caminho VRF de produção (`#[cfg(not(feature = "testing"))]`) **nunca foi exercitado** (nem diário, nem mensal); sem multisig na `global_state.admin`; rent das `MonthlyClaim` nunca recuperado (~0,0011 SOL/ticket/mês).

---

## 3. A-1 RESOLVIDO — `cancel_monthly_draw` (2026-09-07)

**Problema:** um sorteio mensal travado no status 0 (`close_monthly_draw` não roda — conta de randomness ruim, janela VRF perdida, outage Switchboard — e `request_monthly_randomness` não re-solicita) deixava o `pool_snapshot` preso no `monthly_vault` pra sempre. O diário tem `reset_draw_settlement`; o mensal não tinha nada.

**Solução:** `cancel_monthly_draw`
- **Só status 0** (de propósito): status 1+ tem `result_numbers` derivado → cancelar viraria grinding de VRF; status 4 seria duplo pagamento. Admin-gated. Só o mensal mais recente.
- **Devolve:** `monthly_vault → prize_vault` (valor = `pool_snapshot`, não `monthly_vault.amount`) + `global_state.monthly_pool += pool_snapshot`. Reverso EXATO do `open_monthly_draw` — conservação fecha.
- **Reverte:** `last_covered_draw_id` (id==1 → 0; senão `first_draw_id - 1`) e `current_monthly_id` (→ `id - 1`). Fecha a conta `MonthlyDraw` (rent → admin). O range volta a ser cobrível.
- No status 0 não há `MonthlyClaim` (settle nunca rodou).
- Erros novos: `MonthlyDrawNotCancelable`, `MonthlyDrawNotLatest`.

**Recuperação:** `cancel_monthly_draw` → `open_monthly_draw` de novo → `request_monthly_randomness` c/ conta boa → `close_monthly_draw`.

---

## 3-A. M-1 RESOLVIDO — `pay_winners_batch` admin-gated (2026-09-08, commit `65aa360`)

**Problema:** `pay_winners_batch` (diário) era **permissionless** — sem `admin` Signer nenhum, e o `global_state` sem nem validação de PDA. Não roubava (fundos vão pro `ticket.owner`, authority é PDA), mas inconsistente com `pay_monthly_winners_batch` (admin-only) e ampliava o raio de qualquer bug futuro de cálculo de prêmio.

**Solução:**
- `PayWinnersBatch`: `+ admin: Signer` + `has_one = admin` no `global_state` (que ganhou também `seeds`/`bump` da PDA canônica).
- Os 5 `Account<T>` grandes viraram `Box<Account<T>>` — adicionar `admin` + a maquinária de `has_one` estourou o stack frame do BPF (4352 > 4096). Mesmo padrão das 8 instruções mensais. Handler: só 4 ajustes de deref (`&mut *`, `&*`) nas chamadas de `pay_ticket()`. **Zero mudança de lógica de pagamento.**
- Testes: 4 chamadas passam `admin`; **novo teste** "não-admin é rejeitado". `make test` = 66 verdes.
- **Pendente:** os 19 scripts de operação diária que chamam `pay_winners_batch` vão precisar passar `admin` — ficam pro upgrade da devnet (que já é pendência).

---

## 3-B. ⚠️ DECISÃO DE DESIGN DO JOGO — REFAZER O SCORING (Etapas 1-3 feitas, falta a 4)

Descoberto em **2026-09-08**. **Não é bug de segurança** (não perde/rouba dinheiro, conservação continua fechando). Era que **o jogo no código estava diferente do que o dono quer.** Etapas 1 (scoring), 2 (sorteio sempre 6) e 3 (cartela variável) já resolvidas — ver checklist em §1. Falta só a Etapa 4 (preço + multi-crypto) pra fechar de vez.

### JOGO CORRETO (o que o dono quer)

- O sorteio **SEMPRE tira 6 números + 1 crypto** (fixo, em todas as fases).
- As cartelas podem ter **MAIS de 6 números** (6, 8, 10, … conforme a fase permite).
- **Cartela maior custa MAIS CARO.**
- Ganha quem tem os **6 números sorteados CONTIDOS na cartela**. Tier = f(quantos dos 6 sorteados estão na cartela).
- Cartela maior = mais chance de cobrir os 6 (você pagou mais por isso).
- **NUNCA** exigir "acertar todos os números da cartela".

### JOGO ORIGINAL (errado, antes das Etapas 1-3 — histórico)

- O sorteio tirava quantidade **VARIÁVEL** — `numbers_count` = `PHASE_CONFIG.numbers_per_ticket` = **6, 6, 7, 8, 10, 12, 15, 18, 22, 25** por fase (`close_draw.rs:148` / `close_monthly_draw.rs:104`, `generate_unique_numbers(&seed, numbers_count)`).
- A cartela era **obrigada** a ter exatamente `numbers_count` números (`buy_ticket.rs:95`, `require!(numbers.len() == numbers_count)`) — cartela grande era impossível.
- **Preço fixo** (`global_state.ticket_price`, um valor só).
- Ganhava quem acertasse **TODOS** os números da cartela: `resolve_tier` fazia `deficit = numbers_count - hits`; tier 0 exigia `deficit == 0` → `hits == numbers_count`.
- **O mensal ainda penalizava mais:** `settle_monthly_tickets.rs:153` passava `ticket.numbers.len()` como `numbers_count` — cartela grande → `deficit` grande → tier ruim ou `255` (nada). Diário e mensal **inconsistentes** (diário passava `draw.numbers_count`, linha 59).
- **Trace confirmado (antes da correção):** cartela de 10, sorteio `[5,17,27,32,51,57]` (6 bolas), as 6 na cartela, crypto certa → **tier 8** (não jackpot). Cartela de 11 → **255 (nada)**.

### 5 pontos a mudar (fazer EM ETAPAS testadas, com PLANO antes) — A a D feitos, falta E

| # | Onde | Mudança | Status |
|---|---|---|---|
| **A** | `scoring.rs` `resolve_tier` (~linha 47) + call site `settle_monthly_tickets.rs` | `deficit = 6 - hits` (6 = nº fixo de bolas), **não** `numbers_count - hits`. O tamanho da cartela nunca entra na conta do tier. | ✅ **Etapa 1** (`9f46b13`) |
| **B** | `settle_tickets.rs` `resolve_tier` + call site | Mesma correção no diário. | ✅ **Etapa 1** (`9f46b13`) |
| **C** | `close_draw.rs` / `close_monthly_draw.rs` | `generate_unique_numbers(&seed, 6)` **sempre** (constante, não `numbers_count`). | ✅ **Etapa 2** (`5f7c759`) |
| **D** | `buy_ticket.rs` (`validate_numbers`) + `Ticket::len()` + `set_numbers_count` | Cartela de tamanho variável: `6..=numbers_count` (teto por fase, não valor exato). `numbers_count` continua vindo do `PHASE_CONFIG`/`advance_phase`, mas agora é teto; nova instrução `set_numbers_count` corrige o teto numa instância já inicializada. | ✅ **Etapa 3** (`f1ec991`) |
| **E** | `buy_ticket.rs` / `buy_ticket_with_referral.rs` / `claim_bonus_ticket.rs` (preço) + `validate_crypto` / cartela (multi-crypto) | **Preço combinatório:** `ticket_price(n) = C(n, 6) × k` — `n` = tamanho da cartela, `C(n,6)` = combinações de 6 dentre os `n` números escolhidos (mede quantas "apostas de 6" a cartela de fato cobre), `k` = preço-base por combinação (spec do dono). **Multi-crypto:** a cartela passa a poder escolher **mais de 1** crypto (hoje é sempre exatamente 1, `PhaseConfig.max_cryptos` já existe mas está morto desde a Etapa do `crypto_count`) — acertar QUALQUER uma das escolhidas conta como crypto certa; preço sobe também com o nº de criptos escolhidas. | ⏳ **Etapa 4 (próxima)** |

### AVISOS

- **Estrutura do `Ticket` já mudou na Etapa 3** (`numbers_count` deixou de ser o tamanho exato pra ser o teto) → **tickets antigos da devnet continuam incompatíveis** (mesmo aviso de antes, ambiente de teste, aceito).
- É o **coração do jogo — diário E mensal.** `count_hits` já está certo (conta a interseção); as Etapas 1-3 resolveram `resolve_tier` + o sorteio + a compra (tamanho). Falta só a Etapa 4 (preço + multi-crypto).
- Etapa 4 impacta os **BPS de tier** e a economia (cartela grande paga mais e ganha mais) — revisar o `PHASE_CONFIG` e o `TIER_BPS` junto.
- Precisa de **spec escrita do dono** pra Etapa 4: o valor de `k` (preço-base por combinação) e como o preço escala com o nº de criptos escolhidas, antes de codar.

---

## 4. PENDÊNCIAS — achados de auditoria abertos (decisões de produto / melhorias, NÃO urgentes)

Nenhum trava produção sozinho; nenhum perde/rouba dinheiro. Retomar caso a caso.

### 🟡 Médios

| # | O que é | Nota |
|---|---|---|
| ~~**M-1**~~ | ~~`pay_winners_batch` (diário) é PERMISSIONLESS~~ | ✅ **RESOLVIDO** em 2026-09-08 (§3-A). Agora é admin-gated. |
| **M-2** | **Mensal que cruza transição de fase pontua enviesado.** `numbers_per_ticket` muda por fase (6→7→8…). Um mensal com range de 2 fases usa UM `numbers_count` — tickets do formato maior num mensal menor não podem ganhar o jackpot. Não perde dinheiro (jackpot não reclamado rola). | Decisão de produto: como o mensal deve tratar ranges multi-fase. |
| **M-3** | **Primeira mensal não é obrigada a começar na draw 1.** Se abrir em, digamos, draw 50, os holders das draws 1–49 contribuíram 20% pro pool mas nunca podem ganhar um mensal. Sem enforcement on-chain. | Convenção operacional (começar em 1) ou guard on-chain. |
| **M-4** | **`open_monthly_draw` não impede abrir a mensal N+1 antes da N estar paga.** Conservação se mantém (snapshot por-draw), mas comingla fundos no `monthly_vault` e confunde a contabilidade. | Guard "termine a anterior" ou aceitar. |
| **M-5** | **`MAX_DRAWS_PER_MONTH = 40` é inalcançável numa tx legada.** 40 contas Draw em `remaining_accounts` estoura 1232 bytes (~20–25 é o teto real). Sem versão incremental do `open_monthly_draw`. | Migrar scripts pra transações versionadas + Address Lookup Tables, ou aceitar mensais não-alinhados ao mês calendário. |
| **M-6** | **`settle_monthly_tickets` sem escape hatch** se `tickets_target` superestimar os tickets reais (não achei caminho pra isso acontecer, mas o diário tem `reset_draw_settlement` e o mensal não). | Se M-6 virar real, uma ferramenta estreita (`force_settle_complete` c/ grace period) — não o `cancel` geral. |

### 🟢 Baixos

| # | O que é |
|---|---|
| **B-1** | `total_monthly_draws` nunca é incrementado — sempre 0 (campo de stat morto). |
| **B-2** | `jackpot_carry` só é escrito, nunca lido (mirror informativo). |
| **B-3** | `split_evenly` retorna `MathOverflow` pro caso `winners == 0` (erro semanticamente errado, inalcançável). |
| **B-4** | `cascade_and_divide` retorna `InvalidMonthlyRange` pro mismatch de tamanho de slice (erro estranho). |
| **B-5** | `pay_monthly_winners_batch` linhas 74–81: dois `require!` redundantes com o `constraint` da struct. |
| **B-6** | `unbiased_byte` / `generate_unique_numbers` sem guard pra divisor 0 → panic teórico (inalcançável: callers passam 10 hardcoded, pool 72). |
| **B-7** | `randomness.rs::generate_unique_numbers` linha ~121: `byte_idx += 1` antes de `h.0[byte_idx % 32]` — indexa com valor pós-incremento. Determinístico, idêntico ao diário (paridade passa), praticamente nunca alcançado. |

### Pendências de infra / produção (já mapeadas antes)

- [ ] **Rent das `MonthlyClaim` nunca recuperado** — 1 conta (~0,0011 SOL, paga pelo admin) por ticket por mês. 10k tickets/mês ≈ 11 SOL travados/mês. Decidir: instrução de close pós-ciclo ou aceitar.
- [ ] **`monthly_cycle_duration = 0` na devnet** — cosmético (nenhuma instrução mensal lê). Mainnet resolve no `initialize` fresh.
- [ ] **Draws antigas da devnet congeladas** — o upgrade trocou `[u8;6]` → `Vec<u8>`; os ~285 draws antigos ficaram ilegíveis. Aceito (dados de teste). Reversível via rollback ou migração.
- [ ] **D6** — `monthly_pool` da devnet tem dinheiro de teste. Problema só de mainnet (deploy fresh = vaults fresh).
- [ ] **Scripts de operação de produção** — os `scripts/devnet-*.ts` são one-offs. Falta runner robusto pro ciclo mensal completo (open/settle em lote/finalize/pay).
- [ ] **Teste de escala** — mensal testado com no máx. 53 vencedores. Um mês real = milhares de tickets. Medir CU, tamanho de tx, custo em SOL.
- [ ] **Frontend — aba mensal** — não existe. Corrigir legenda "15% Monthly" → 20%.
- [ ] **Auditoria externa** das partes novas antes de mainnet.
- [ ] **Merge `feature/monthly-draw-batch-pay` → `main`** (+ a `main` local está 3 commits à frente da `origin/main`).
- [ ] **Mainnet** — nunca deployado. Sem program ID, sem multisig na upgrade authority, sem bug bounty.

---

## 5. ESTADO ATUAL — pra retomar

- **Branch:** `feature/monthly-draw-batch-pay` — **em dia com o `origin`** (HEAD `f1ec991`, 0 commits à frente). Não mergeada na `main`.
- **Testes:** `make test` = **73 passing / 0 failing / 1 pending** · `make test-rust` = **27 passing**.
- **Build:** `default = []` (seguro por padrão). `make build-prod` gera o binário de produção verificado. Fluxo em `DEPLOY.md`.
- **Devnet:** programa no slot `493679424` (2026-09-05), buildado **COM `testing`**, **25 instruções** (a branch tem **27** — faltam `cancel_monthly_draw`, o `pay_winners_batch` admin-gated, `set_numbers_count`, e a limpeza do build). `monthly_state`/`monthly_vault` criados, `crypto_count = 10`, `numbers_count` ainda com a semântica antiga (exata, não teto — só passa a valer teto quando esse binário for trocado). Monthly draw #1 completo (smoke test). `last_covered_draw_id = 287` → próximo mensal a partir da draw 288. `monthly_pool ≈ 1.187 USDT` (rollover do smoke test + dinheiro de teste).
- **Rollback do bytecode devnet:** `scripts/rollback/devnet_2026-04-20_slot456737049.so` (sha `38f5679e…`).

### Próximos passos sugeridos (ordem)

1. 🔴 **A PRÓXIMA SESSÃO COMEÇA AQUI: Etapa 4, última da correção do jogo (§3-B).** Pegar a spec escrita do dono pro valor de `k` (preço-base por combinação em `C(n,6) × k`) e pra como o preço escala com o nº de criptos escolhidas, fazer um PLANO por etapas, e implementar preço combinatório + multi-crypto em etapas testadas. Fecha o coração do jogo (diário + mensal).
2. Decidir merge `feature → main` (e se envia a `main` local).
3. `make build-prod` + upgrade da devnet pro binário de produção (sem `testing`) — sabendo que aí o fluxo via keypair-lixo para; precisa dos scripts de Switchboard real. **Fazer depois do item 1**, pra não deployar duas vezes.
4. Decidir sobre M-2/M-3 (fairness de mensal multi-fase / primeira mensal) — provavelmente resolvidos "de graça" pela mudança do §3-B (sorteio sempre 6).
5. Rent das `MonthlyClaim`.
6. Scripts de operação + teste de escala.
7. Auditoria externa → frontend → mainnet.

---

## Referência rápida

```bash
# testes
make test        # 73 (anchor, com --features testing)
make test-rust   # 27 (cargo --lib)

# build de produção (sem testing) + verificação
make build-prod

# rodar um ciclo mensal na devnet (fase por fase) — editar DRAW_A/DRAW_B/TICKETS
export ANCHOR_PROVIDER_URL="<RPC Helius devnet privado>"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
export TS_NODE_TRANSPILE_ONLY=1
PHASE=setup|open|close|settle|finalize|pay|check ./node_modules/.bin/ts-node scripts/devnet-smoke-monthly.ts

# rollback do bytecode devnet (emergência)
solana program deploy scripts/rollback/devnet_2026-04-20_slot456737049.so \
  --program-id 2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS \
  --upgrade-authority /mnt/c/Users/becke/temp.json --url "<RPC>" --use-rpc
```

## Commits da branch (todos no `origin`)

```
f1ec991 feat(ticket): cartela de tamanho variável, 6 a 25 números (Etapa 3)
5f7c759 feat(draw): sorteio sempre tira 6 números, qualquer fase (Etapa 2)
9f46b13 fix(scoring): tier pelo tamanho do sorteio, não da cartela (Etapa 1)
86224d2 docs: checkpoint 2026-09-08 — M-1 resolvido + decisão de refazer o scoring do jogo
65aa360 fix(security): pay_winners_batch admin-gated (M-1)
253ac48 feat(monthly): cancel_monthly_draw — escape hatch de emergência (A-1)
62d2a3c build: default sem feature testing — produção segura por padrão
5573412 docs: checkpoint do progresso do sorteio mensal (2026-09-05)
9045e90 chore(devnet): script de setup da PARTE B
051613b chore(rollback): snapshot do bytecode devnet pré-upgrade
332ef7b chore(idl): versiona o IDL gerado
b751b76 chore(devnet): scripts do smoke test + scan de draws
d1f04db feat(monthly-3E): pay_monthly_winners_batch
98d9954 feat(monthly): fecha a 3D
537b4ac feat(crypto): crypto 1..10 desde a fase 1
68adc31 wip(3D): finalize_monthly_payouts
65705b6 feat(monthly): settle_monthly_tickets (3C)
8bd7039 feat(monthly): VRF mensal (3B)
eaed624 feat(monthly): open_monthly_draw (3A)
a08684e feat(monthly): estado mensal (Etapa 2) + fix monthly_cycle_duration=0
74ad40f test(pay_winners_batch): valida lote + idempotência
888844a feat(pay_winners_batch): lote via remaining_accounts
```
