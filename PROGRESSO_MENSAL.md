# MegaByt — Progresso do Sorteio Mensal

> Checkpoint escrito em **2026-09-05**. Onde estou, o que está feito, o que falta.
> Branch de trabalho: `feature/monthly-draw-batch-pay` (no GitHub, **não** mergeada na `main`).

---

## 1. O QUE ESTÁ FEITO ✅

### Código (branch `feature/monthly-draw-batch-pay`, tudo no GitHub)

- [x] **Etapa 1** — `pay_winners_batch` refatorado pra lote real via `remaining_accounts` (idempotente)
- [x] **Etapa 2** — structs `MonthlyState` / `MonthlyDraw` / `MonthlyClaim` + `init_monthly_state` + `init_monthly_vault`; `initialize.rs` corrigido pra gravar `monthly_cycle_duration` real
- [x] **3A** — `open_monthly_draw` (snapshot do `monthly_pool`, split 75/25, sweep físico `prize_vault → monthly_vault`, contiguidade de range)
- [x] **3B** — `request_monthly_randomness` + `close_monthly_draw` + módulo `randomness.rs` (cópia byte-a-byte dos helpers do diário + testes de paridade)
- [x] **3C** — `settle_monthly_tickets` (lote, dedup via `MonthlyClaim` criada por CPI) + módulo `scoring.rs`
- [x] **Mudança de crypto** — `crypto_count = 10` desde o `initialize`; nova instrução `set_crypto_count` (admin, 1..10); `advance_phase` não mexe mais em `crypto_count`
- [x] **3D** — `finalize_monthly_payouts` + módulo `payouts.rs` (split do jackpot, cascata + anti-esmola, sweep-espelho de volta, prova de conservação)
- [x] **3E** — `pay_monthly_winners_batch` (lote real, tier 255 pulado, idempotente, status 3→4)

**Ciclo mensal completo:** `open → request → close → settle → finalize → pay`.

### Testes

- [x] `anchor test`: **63 passing / 0 failing** (1 pending: `init_monthly_vault rejeita mint diferente` — só roda em estado 100% limpo)
- [x] `cargo test --manifest-path programs/megabyt/Cargo.toml --lib`: **11 passing** (paridade `randomness`/`scoring`/`payouts` + jackpot)
- [x] Prova isolada "jackpot sem ganhador → cascata ainda paga" (Draw C em `tests/monthly_finalize_payouts.ts`)

### Devnet — programa `2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS`

- [x] **Upgrade do bytecode** — slot `493679424` (era `456737049` de 2026-04-20). Byte-a-byte igual ao `target/deploy/megabyt.so` local (sha `5710a5b2…`)
- [x] **IDL publicado on-chain** — 25 instruções
- [x] `init_monthly_state` → `9rdexPKYN42KWtuJeB9bGPf9z41LxHmcPt2KEwkmHddz` (criada, zerada)
- [x] `init_monthly_vault` → `CW4Y9KBsCPputhFFcTPCJydoNHwaXoege7cDW1wph2KT` (mint USDT, authority `vault-authority-v3`)
- [x] `set_crypto_count(10)` → `global_state.crypto_count = 10`
- [x] **Smoke test do ciclo completo executado** — monthly draw #1, range `[286, 287]`, 4 tickets, 1 vencedor tier 3:
  - `open` `5f9rbTvn…` · `close` `2P9Yq16a…` · `settle` `5J3RcUFk…` · `finalize` `PaWr6Bwc…` · `pay` `5tSHpcPw…`
  - snapshot `1.387.460.000` → pago `200.410.887` + rollover `1.187.049.113` = **conservação exata**
  - regras provadas rodando: jackpot sem ganhador acumula 100%; cascata paga sem jackpot; anti-esmola; status 0→4

### Chaves / infra devnet

| | pubkey | keypair | saldo aprox |
|---|---|---|---|
| Upgrade authority | `pxTedq6HYJ787byoh6Sh6t7YndsJFacJ99fjBqWjSnm` | `/mnt/c/Users/becke/temp.json` | ~34,5 SOL |
| Admin (`global_state.admin`) | `AueuFaAd9RYPdnc3aB3RmWPzni3XZiYUqoS3a1mgcvzb` | `~/.config/solana/id.json` | ~66 SOL |
| RPC usado | RPC devnet privado (Helius) — o público (`api.devnet.solana.com`) **não aguenta** o deploy | — | — |

### Commits nesta branch (todos no `origin`)

```
b751b76 chore(devnet): scripts do smoke test + scan de draws
9045e90 chore(devnet): script de setup da PARTE B
051613b chore(rollback): snapshot do bytecode devnet pré-upgrade
332ef7b chore(idl): versiona o IDL gerado
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

---

## 2. ESTADO ATUAL DA DEVNET (pra não me confundir)

- `global_state`: `crypto_count = 10` ✅ · `monthly_cycle_duration = 0` (cosmético, ver §3) · `monthly_pool = 1.187.049.113` (rollover do smoke test — dinheiro de teste)
- `monthly_state`: `current_monthly_id = 1` · `last_covered_draw_id = 287` → **o próximo mensal tem que cobrir a partir da draw 288**
- `monthly-vault-v3`: saldo **0** (ciclo #1 totalmente distribuído)
- Monthly draw #1: `status = 4` (completo, imutável)
- Draws diárias **1–285**: **CONGELADAS** — ilegíveis pelo programa novo (ver §3). Não pagas: 150, 250, 284, etc. ficaram assim.
- Draws **286, 287**: criadas pelo programa novo, fechadas (`status 1`), **sem settle/pay no nível diário** (de propósito — o mensal só precisava de `status ≥ 1`)
- Rollback disponível: `scripts/rollback/devnet_2026-04-20_slot456737049.so` (sha `38f5679e…`)

---

## 3. PENDÊNCIAS CONHECIDAS (decisões já tomadas — deixadas pra depois de propósito)

### 3.1 Build de produção SEM a feature `testing` 🔴 (bloqueador de mainnet)

- `programs/megabyt/Cargo.toml` tem `default = ["testing"]`.
- **O bytecode na devnet HOJE foi buildado COM `testing`** → `close_draw` E `close_monthly_draw` caem num seed determinístico fixo (`[1,2,…,32]` → sempre `[5,17,27,32,51,57]`/crypto 9) quando a conta de randomness não faz parse. Qualquer um passa conta lixo e prevê o resultado. **OK pra devnet de teste, NUNCA pra produção.**
- **Pra staging/mainnet:** buildar com `anchor build -- --no-default-features` (ou tirar `testing` do `default`). Aí `close_*` só aceita Switchboard real.
- **Cuidado:** sem `testing`, o `anchor test` local quebra (depende do seed determinístico). Precisa separar: testes rodam com `--features testing`, deploy roda sem. Definir isso no fluxo antes do primeiro deploy sério.

### 3.2 Rent das `MonthlyClaim` nunca é recuperado 🟡

- `settle_monthly_tickets` cria **1 `MonthlyClaim` por ticket por sorteio mensal** via CPI ao System Program, rent (~0,0011 SOL) paga pelo **admin**. Nenhuma instrução fecha essas contas.
- Um mês real com N tickets = N × 0,0011 SOL **travados pra sempre**. 10k tickets/mês ≈ 11 SOL/mês.
- **Opções:** (a) instrução nova `close_monthly_claims` que roda depois do ciclo `paid` (status 4) e devolve o rent pro admin — atenção: quebra a idempotência do reenvio do `pay` (claim fechada não tem mais o flag `paid` pra pular); (b) fechar a claim dentro do próprio `pay_monthly_winners_batch` depois de pagar, com a mesma ressalva; (c) aceitar o custo.
- No smoke test: 4 claims (~0,0044 SOL) — irrelevante. Só importa em escala.

### 3.3 `monthly_cycle_duration = 0` na devnet 🟢 (cosmético)

- `initialize.rs` já foi corrigido, mas `initialize` só roda 1x e o `global_state` da devnet já existe.
- Efeito: o bloco "MONTHLY CYCLE ROLLOVER" do `close_draw.rs` incrementa `monthly_cycles_completed` a **cada** fechamento de draw. **Nenhuma instrução mensal lê `monthly_cycle_*`** — zero impacto financeiro.
- **Pra corrigir de vez** (se algum dia importar): instrução admin `set_monthly_cycle(start, duration)` — bundle junto com um eventual reset do `monthly_pool` (D6). Ou, no mainnet, o `initialize` fresh já nasce certo.

### 3.4 Draws antigas da devnet congeladas 🟢 (aceito — dados de teste descartáveis)

- O upgrade trocou `Ticket.numbers` / `Draw.result_numbers` de `[u8; 6]` (array fixo) pra `Vec<u8>` (commit `8388365`, pós-deploy de abril). Todos os ~285 draws + tickets antigos ficaram binariamente incompatíveis.
- **Se um dia importar:** rollback pro bytecode de abril (`scripts/rollback/…`) OU script de migração das contas.

### 3.5 D6 — dinheiro de teste no `monthly_pool` 🟢 (problema só de mainnet)

- `monthly_pool` na devnet = `1.187.049.113` (~1187 USDT de teste, resto do que sobrou do smoke test).
- Na devnet, tanto faz. **Mainnet: deploy fresh = vaults fresh = zero dinheiro de teste.** Nunca rodar o primeiro mensal real com pool contaminado.

### 3.6 `open_monthly_draw` sem trava de tempo on-chain 🟡

- É 100% admin-triggered. O `monthly_cycle_duration`/`monthly_cycles_completed` do `close_draw` está **desconectado** do sistema mensal novo.
- **Decidir:** deixar admin-only (mais simples), ou adicionar checagem de "já passou o ciclo?" no `open_monthly_draw`.

---

## 4. O QUE FALTA (nunca começado)

- [ ] **Scripts de operação de produção** — os de `scripts/devnet-*.ts` são one-offs de devnet. Falta runner robusto pra: `open_monthly_draw` (com o range certo de draws), `settle` em lote (10–13 tickets/tx, retry, rastrear quais claims já existem), `finalize`, `pay` em lote. Idem pro `pay_winners_batch` diário em lote (nunca foi ligado na operação).
- [ ] **Teste de escala** — mensal testado com no máx. 53 vencedores (local) / 4 tickets (devnet). Um mês real = ~30 draws × milhares de tickets = centenas/milhares de tx. Medir CU, tamanho de tx, custo total em SOL.
- [ ] **Frontend — aba mensal** — não existe. Corrigir também a legenda "15% Monthly" (a regra é 20% = 15% + 5% referral).
- [ ] **Auditoria das partes novas** — `AUDIT_REPORT.md` / `CHECKLIST_PRODUCAO.md` cobrem só as 17 instruções diárias. **Zero auditoria** de: 8 instruções mensais, `set_crypto_count`, refactor do `pay_winners_batch`, módulos `randomness.rs` / `scoring.rs` / `payouts.rs`. O dinheiro do mensal passa por aí.
- [ ] **Merge `feature/monthly-draw-batch-pay` → `main`** (+ a `main` local está 3 commits à frente da `origin/main`, não enviados).
- [ ] **Mainnet** — nunca deployado. Sem program ID, sem keypair, sem multisig na upgrade authority, sem bug bounty, sem plano de incidente. Switchboard On-Demand em mainnet (custo de VRF por sorteio).

---

## 5. PRÓXIMOS PASSOS — por onde começar

**Curto prazo (devnet / consolidação):**
1. Decidir: merge `feature → main` agora, ou manter na branch até auditar? (+ decidir se envia a `main` local pro `origin`)
2. Resolver o build de produção (§3.1): separar `anchor test` (com `testing`) de `anchor build`/deploy (sem). Documentar no fluxo.
3. Decidir o destino do rent das `MonthlyClaim` (§3.2) — instrução de close ou aceitar custo. Se for instrução, é código novo → build + teste + deploy.
4. Se for continuar exercitando na devnet: escrever os scripts de operação (§4) e rodar um mensal de escala maior (ex. 200–500 tickets) medindo custo/tempo.

**Antes de qualquer conversa de mainnet:**
5. Auditoria externa das partes novas (§4).
6. Build sem `testing` + deploy fresh + `initialize` fresh (nasce com `monthly_cycle_duration` e `crypto_count` certos) + vaults fresh (sem dinheiro de teste).
7. Frontend mensal.

---

## Referência rápida — rodar coisas na devnet

```bash
export ANCHOR_PROVIDER_URL="<RPC Helius devnet privado>"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"   # admin
export TS_NODE_TRANSPILE_ONLY=1

# inspecionar draws
FROM=280 TO=300 ./node_modules/.bin/ts-node scripts/devnet-scan-draws.ts

# rodar um ciclo mensal (fase por fase) — editar DRAW_A/DRAW_B/TICKETS no script primeiro
PHASE=setup    ./node_modules/.bin/ts-node scripts/devnet-smoke-monthly.ts
PHASE=open     ./node_modules/.bin/ts-node scripts/devnet-smoke-monthly.ts
PHASE=close    ./node_modules/.bin/ts-node scripts/devnet-smoke-monthly.ts
PHASE=settle   ./node_modules/.bin/ts-node scripts/devnet-smoke-monthly.ts
PHASE=finalize ./node_modules/.bin/ts-node scripts/devnet-smoke-monthly.ts
PHASE=pay      ./node_modules/.bin/ts-node scripts/devnet-smoke-monthly.ts
PHASE=check    ./node_modules/.bin/ts-node scripts/devnet-smoke-monthly.ts

# rollback do bytecode (emergência)
solana program deploy scripts/rollback/devnet_2026-04-20_slot456737049.so \
  --program-id 2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS \
  --upgrade-authority /mnt/c/Users/becke/temp.json --url "<RPC>" --use-rpc
```
