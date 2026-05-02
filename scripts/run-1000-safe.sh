#!/usr/bin/env bash
set -euo pipefail

cd ~/projects/megabyt

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

# Para 1000 tickets, usa margem generosa.
# 500 levou ~13.5 min, então 5400s (90 min) fica bem seguro.
export DURATION="${DURATION:-5400}"

# Stress target
export TICKETS="${TICKETS:-1000}"
export MULTI="${MULTI:-5}"

echo "=============================================================="
echo " MEGABYT — SAFE 1000 TICKET STRESS RUN"
echo "=============================================================="
echo "RPC:       $ANCHOR_PROVIDER_URL"
echo "WALLET:    $ANCHOR_WALLET"
echo "DURATION:  $DURATION"
echo "TICKETS:   $TICKETS"
echo "MULTI:     $MULTI"
echo "=============================================================="
echo

echo "[1/3] Current wallet address:"
solana address -k "$ANCHOR_WALLET"

echo
echo "[2/3] Current wallet balance:"
solana balance -k "$ANCHOR_WALLET" --url devnet

echo
echo "[3/3] Running flow-master-final.ts ..."
echo

npx ts-node --transpile-only scripts/flow-master-final.ts | tee "stress-${TICKETS}-$(date +%Y%m%d-%H%M%S).log"

echo
echo "=============================================================="
echo " SAFE 1000 RUN FINISHED"
echo "=============================================================="
echo "Next recommended commands:"
echo
echo "  # Audit dashboard"
echo "  ANCHOR_PROVIDER_URL=$ANCHOR_PROVIDER_URL ANCHOR_WALLET=$ANCHOR_WALLET npx ts-node --transpile-only scripts/audit-summary.ts"
echo
echo "  # Verify a specific draw"
echo "  ANCHOR_PROVIDER_URL=$ANCHOR_PROVIDER_URL ANCHOR_WALLET=$ANCHOR_WALLET DRAW_ID=SEU_DRAW npx ts-node --transpile-only scripts/verify-draw.ts"
echo

