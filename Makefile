# MegaByt — build & test
#
# SEGURO POR PADRÃO: `anchor build` cru = binário de PRODUÇÃO (VRF Switchboard
# real, sem fallback determinístico). A feature `testing` NÃO está no
# `default` do Cargo.toml — os testes a ligam explicitamente aqui.
#
#   make test        # 63 testes de integração (anchor) COM a feature testing
#   make test-rust   # 11 testes unitários Rust (não dependem da feature)
#   make test-all    # os dois
#   make build-prod  # binário de produção + verificação objetiva
#   make idl         # (re)gera o IDL (é feature-independente)
#
# Ver DEPLOY.md.

.PHONY: test test-rust test-all build-prod build-prod-verifiable idl verify clean

# --- testes -----------------------------------------------------------------

test:
	anchor test -- --features testing

# não builda o programa (útil quando só os testes .ts mudaram e já rodou
# `anchor test` uma vez com a feature)
test-fast:
	anchor test --skip-build

test-rust:
	cargo test --manifest-path programs/megabyt/Cargo.toml --lib

test-all: test-rust test

# --- build de produção ----------------------------------------------------

# `default = []` no Cargo.toml, então `anchor build` cru já é sem `testing`.
build-prod:
	anchor build
	./scripts/verify-no-testing.sh target/deploy/megabyt.so

# build determinístico/reproduzível (docker) — usar pra mainnet
build-prod-verifiable:
	anchor build --verifiable
	./scripts/verify-no-testing.sh target/deploy/megabyt.so

verify:
	./scripts/verify-no-testing.sh target/deploy/megabyt.so

# --- IDL ------------------------------------------------------------------

# O IDL é idêntico com ou sem a feature `testing` (ela só muda o corpo de
# 2 handlers, não assinaturas/contas/tipos).
idl:
	anchor build --no-docs

clean:
	cargo clean
	rm -rf .anchor test-ledger
