import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

function toNumberSafe(value: any): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value?.toNumber === "function") return value.toNumber();

  if (typeof value?.toString === "function") {
    const n = Number(value.toString());
    if (!Number.isNaN(n)) return n;
  }

  return 0;
}

async function main() {
  console.log("=== MegaByt Finalize Draw 1 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace.Megabyt as Program<any>;

  const globalState = new PublicKey("FMvkTjV9sZoy1RSptLMGenwXModkK8EF863vUrxBFRqS");
  const drawState = new PublicKey("EmvVwQxZKStN9XcBdFSoSe1WACdoYa6BBHRLvNNmWpaT");

  console.log("Admin:", wallet.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", provider.connection.rpcEndpoint);
  console.log("GlobalState:", globalState.toBase58());
  console.log("Draw:", drawState.toBase58());

  let draw = await program.account.draw.fetch(drawState);

  console.log("\n=== STATUS ANTES ===");
  console.log("status:", toNumberSafe(draw.status));
  console.log("ticketsSold:", toNumberSafe(draw.ticketsSold ?? draw.tickets_sold));
  console.log("ticketsProcessed:", toNumberSafe(draw.ticketsProcessed ?? draw.tickets_processed));
  console.log("settlementComplete:", !!(draw.settlementComplete ?? draw.settlement_complete));
  console.log("settled:", !!draw.settled);
  console.log("isPaid:", !!(draw.isPaid ?? draw.is_paid));

  const sig = await program.methods
    .finalizePayouts()
    .accounts({
      globalState,
      draw: drawState,
    })
    .rpc();

  console.log("\nfinalizePayouts tx:", sig);

  draw = await program.account.draw.fetch(drawState);

  console.log("\n=== STATUS DEPOIS ===");
  console.log("status:", toNumberSafe(draw.status));
  console.log("ticketsSold:", toNumberSafe(draw.ticketsSold ?? draw.tickets_sold));
  console.log("ticketsProcessed:", toNumberSafe(draw.ticketsProcessed ?? draw.tickets_processed));
  console.log("settlementComplete:", !!(draw.settlementComplete ?? draw.settlement_complete));
  console.log("settled:", !!draw.settled);
  console.log("isPaid:", !!(draw.isPaid ?? draw.is_paid));
  console.log(
    "winnerCounts:",
    (draw.winnerCounts ?? draw.winner_counts ?? []).map((x: any) => toNumberSafe(x))
  );
  console.log(
    "prizePerTier:",
    (draw.prizePerTier ?? draw.prize_per_tier ?? []).map((x: any) => toNumberSafe(x))
  );
}

main().catch((err) => {
  console.error("Erro:", err);
  process.exit(1);
});

