import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

function toNumberSafe(value: any): number {
  if (value == null) return 0;

  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value?.toNumber === "function") return value.toNumber();

  if (typeof value?.toString === "function") {
    const parsed = Number(value.toString());
    if (!Number.isNaN(parsed)) return parsed;
  }

  return 0;
}

function toArraySafe(value: any): number[] {
  if (Array.isArray(value)) {
    return value.map((v) => toNumberSafe(v));
  }
  return [];
}

async function main() {
  console.log("=== MegaByt Finalize Draw 14 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const program = anchor.workspace.Megabyt as Program<any>;

  const globalState = new PublicKey("EM4tBuJCFjRd2BLMs61fG6Gh1Q7pEmanJTUyYdoUg1Ln");
  const drawState = new PublicKey("3aXXSmikAyPJ6mgFpcea6d3XUvCbN1E1DBFvFuyf4eHt");

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);
  console.log("GlobalState:", globalState.toBase58());
  console.log("Draw:", drawState.toBase58());

  const before = await program.account.draw.fetch(drawState);

  console.log("=== STATUS ANTES ===");
  console.log("status:", toNumberSafe(before.status));
  console.log("isClosed:", !!before.isClosed);
  console.log("settled:", !!before.settled);
  console.log("settlementComplete:", !!before.settlementComplete);
  console.log("ticketsSold:", toNumberSafe(before.ticketsSold));
  console.log("ticketsProcessed:", toNumberSafe(before.ticketsProcessed));
  console.log("totalCollected:", toNumberSafe(before.totalCollected));
  console.log("prizePool:", toNumberSafe(before.prizePool));
  console.log("winnerCounts:", toArraySafe(before.winnerCounts));
  console.log("prizePerTier:", toArraySafe(before.prizePerTier));

  console.log("Chamando finalizePayouts...");
  const sig = await program.methods
    .finalizePayouts()
    .accounts({
      globalState,
      draw: drawState,
    })
    .rpc();

  console.log("finalizePayouts tx:", sig);

  const after = await program.account.draw.fetch(drawState);

  console.log("=== STATUS DEPOIS ===");
  console.log("status:", toNumberSafe(after.status));
  console.log("isClosed:", !!after.isClosed);
  console.log("settled:", !!after.settled);
  console.log("settlementComplete:", !!after.settlementComplete);
  console.log("ticketsSold:", toNumberSafe(after.ticketsSold));
  console.log("ticketsProcessed:", toNumberSafe(after.ticketsProcessed));
  console.log("totalCollected:", toNumberSafe(after.totalCollected));
  console.log("prizePool:", toNumberSafe(after.prizePool));
  console.log("winnerCounts:", toArraySafe(after.winnerCounts));
  console.log("prizePerTier:", toArraySafe(after.prizePerTier));

  console.log("=== FINALIZE CONCLUÍDO ===");
  console.log("Draw 14:", drawState.toBase58());
}

main().catch((err) => {
  console.error("Erro:", err);
  process.exit(1);
});

