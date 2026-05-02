import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

const DRAW = new PublicKey("BBCA6i3XP9srRYWeqfpqUB8SZp2yJemDjfeToxSHzM9Q");

async function main() {
  console.log("=== FINALIZE DRAW 12 ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const admin = provider.wallet as anchor.Wallet;

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state")],
    program.programId
  );

  const before = await program.account.draw.fetch(DRAW);

  console.log("Status antes:", Number(before.status));
  console.log("isClosed antes:", before.isClosed);
  console.log("settled antes:", before.settled);
  console.log("settlementComplete antes:", before.settlementComplete);
  console.log("ticketsProcessed antes:", Number(before.ticketsProcessed));
  console.log("ticketsSold antes:", Number(before.ticketsSold));

  console.log("Finalizing payouts...");

  await program.methods
    .finalizePayouts()
    .accounts({
      admin: admin.publicKey,
      globalState,
      draw: DRAW,
    })
    .rpc();

  const after = await program.account.draw.fetch(DRAW);

  console.log("=== RESULTADO FINAL ===");
  console.log("Status final:", Number(after.status));
  console.log("isClosed final:", after.isClosed);
  console.log("settled final:", after.settled);
  console.log("settlementComplete final:", after.settlementComplete);
  console.log("ticketsProcessed final:", Number(after.ticketsProcessed));
  console.log("ticketsSold final:", Number(after.ticketsSold));
  console.log("winnerCounts:", after.winnerCounts.map((n) => Number(n)));
  console.log("prizePerTier:", after.prizePerTier.map((n) => Number(n)));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

