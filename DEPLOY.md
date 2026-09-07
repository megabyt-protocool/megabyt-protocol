# MegaByt — build e deploy

## Regra de ouro

**A feature `testing` NUNCA pode entrar num binário deployado.**

Ela liga um fallback de VRF determinístico em `close_draw` e `close_monthly_draw`
(seed fixo `[1,2,…,32]` → sempre `[5,17,27,32,51,57]` / crypto 9 quando a conta
de randomness não parseia). É só pra `anchor test` rodar sem oráculo Switchboard.
Num binário de produção, qualquer um passaria uma conta lixo e preveria o
resultado do sorteio.

Por isso `programs/megabyt/Cargo.toml` tem **`default = []`** — o comportamento
seguro é o padrão, e o teste exige esforço consciente (`--features testing`,
embrulhado no `make test`).

## Comandos

| | |
|---|---|
| `make test` | 63 testes de integração (`anchor test -- --features testing`) |
| `make test-rust` | 11 testes unitários Rust (`cargo test --lib` — não dependem da feature) |
| `make test-all` | os dois |
| `make build-prod` | `anchor build` (sem `testing`) + `verify-no-testing.sh` |
| `make build-prod-verifiable` | build determinístico em docker (`--verifiable`) — usar pra mainnet |
| `make idl` | (re)gera o IDL (feature-independente) |
| `make verify` | roda só a verificação sobre `target/deploy/megabyt.so` |

## Fluxo de deploy (devnet ou mainnet)

```bash
# 1. build de produção + verificação (aborta se o .so tiver marcador de teste)
make build-prod            # mainnet: make build-prod-verifiable

# 2. (opcional) inspecionar
strings target/deploy/megabyt.so | grep -E "deterministic test seed|Wait for oracle"
#   -> deve mostrar SÓ "...Wait for oracle" (produção), nunca "deterministic test seed"

# 3. deploy / upgrade  (RPC privado — o público não aguenta o buffer write)
solana program deploy target/deploy/megabyt.so \
  --program-id 2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS \
  --upgrade-authority <keypair da upgrade authority> \
  --url "<RPC privado>" --use-rpc --max-sign-attempts 2000

# 4. IDL on-chain
anchor idl upgrade 2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS \
  -f target/idl/megabyt.json --provider.cluster "<RPC>" --provider.wallet <keypair>

# 5. conferir
anchor idl fetch 2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS --provider.cluster "<RPC>" | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)['instructions']),'instruções')"
solana program show 2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS --url "<RPC>"   # slot novo
```

**NUNCA** `anchor build` + `solana program deploy` manual sem passar pelo
`make build-prod` (que roda a verificação). Se precisar deployar sem a Makefile,
rode `./scripts/verify-no-testing.sh target/deploy/megabyt.so` antes, na mão.

## Consequência de deployar sem `testing`

O fluxo diário/mensal que hoje na devnet usa um `Keypair` descartável como conta
de randomness **para de funcionar** — `close_draw` / `close_monthly_draw` passam a
exigir uma conta Switchboard On-Demand real, com o oráculo tendo cumprido o
commit. Os scripts de operação (`scripts/devnet-*.ts`) precisam ser adaptados pra
criar/commitar/aguardar a randomness real antes de fechar.

## Verificação objetiva (como funciona)

As `msg!` do bloco `#[cfg(feature = "testing")]` viram strings no `.so` e só
existem quando a feature está ligada:

- **build de teste** contém: `"deterministic test seed"`, `"testing mode"`,
  `"### BUILD DE TESTE — VRF DETERMINISTICO ###"` — e **não** contém
  `"Wait for oracle"`.
- **build de produção** contém `"...VRF not fulfilled yet. Wait for oracle."` —
  e **nenhum** dos marcadores de teste.

`scripts/verify-no-testing.sh` checa os dois lados.

## Histórico

- **2026-04-20** — deploy original na devnet (slot 456737049), 17 instruções, `[u8;6]`.
- **2026-09-05** — upgrade pra 25 instruções (ciclo mensal 3A–3E), slot 493679424.
  **Buildado COM `testing`** (era o `default` na época) — o binário na devnet HOJE
  tem o fallback determinístico. Aceito pra devnet de teste; **substituir por um
  `make build-prod` antes de qualquer coisa séria.**
- **2026-09-07** — `default = []`, Makefile, `verify-no-testing.sh`, este arquivo.
- Rollback do bytecode de abril: `scripts/rollback/devnet_2026-04-20_slot456737049.so`.
