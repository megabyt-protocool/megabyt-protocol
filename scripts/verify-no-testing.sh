#!/usr/bin/env bash
# Verificação objetiva: o .so NÃO pode conter o fallback determinístico de VRF
# (bloco #[cfg(feature = "testing")] de close_draw.rs / close_monthly_draw.rs).
#
#   ./scripts/verify-no-testing.sh target/deploy/megabyt.so
#
# Sai != 0 se o binário for de teste. Roda dentro do `make build-prod` e deve
# rodar SEMPRE antes de qualquer `solana program deploy` sério.
set -euo pipefail

SO="${1:?uso: verify-no-testing.sh <caminho/para/megabyt.so>}"
[ -f "$SO" ] || { echo "❌ arquivo não encontrado: $SO"; exit 2; }

# dump uma vez pra um buffer — evita SIGPIPE de `strings | grep -q`
DUMP="$(strings "$SO")"
fail=0

# Marcadores que SÓ existem no bloco #[cfg(feature = "testing")]:
for s in "deterministic test seed" "testing mode" "BUILD DE TESTE"; do
  if grep -qF -- "$s" <<<"$DUMP"; then
    echo "❌ FALHA: o .so contém marcador de build de teste: \"$s\""
    fail=1
  fi
done

# String que SÓ existe no caminho de produção (#[cfg(not(feature = "testing"))]):
if ! grep -qF -- "Wait for oracle" <<<"$DUMP"; then
  echo "❌ FALHA: caminho de produção do VRF não encontrado no .so (\"Wait for oracle\" ausente)."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "  Esse binário NÃO é de produção. Buildar com: make build-prod"
  exit 1
fi

echo "✅ OK: $SO — sem fallback de teste; caminho Switchboard de produção presente."
