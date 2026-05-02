import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

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
  console.log("=== MegaByt Pay Draw 1 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace.Megabyt as Program<any>;

  const globalState = new PublicKey("FMvkTjV9sZoy1RSptLMGenwXModkK8EF863vUrxBFRqS");
  const drawState = new PublicKey("EmvVwQxZKStN9XcBdFSoSe1WACdoYa6BBHRLvNNmWpaT");
  const prizeVault = new PublicKey("F1u75nQvBa3rMHy68LT7XqrpAcAJfMwMuMbyNa2LfKYg");
  const vaultAuthority = new PublicKey("FUGvd9WbgCDdHLfGcYcZdceockDsiCGqkWNyC17wHHig");

  const ticket = new PublicKey("4QwMk79JdyUJCUagaxLQAuCvL6Zo2LCi3kuK8jNVPVJg");
  const userTokenAccount = new PublicKey("HUEdWZGX6wjvLfhbvKYHhKnbaUpW5bonR5ryeUw6GvmK");

  let draw = await program.account.draw.fetch(drawState);

  console.log("\n=== STATUS ANTES ===");
  console.log("status:", toNumberSafe(draw.status));
  console.log("isPaid:", !!(draw.isPaid ?? draw.is_paid));
  console.log("ticketsPaid:", toNumberSafe(draw.ticketsPaid ?? draw.tickets_paid));
  console.log(
    "winnerCounts:",
    (draw.winnerCounts ?? draw.winner_counts ?? []).map((x: any) => toNumberSafe(x))
  );

  const sig = await program.methods
    .payWinnersBatch(new anchor.BN(25))
    .accounts({
      globalState,
      draw: drawState,
      ticket,
      prizeVault,
      vaultAuthority,
      userTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("\npayWinnersBatch tx:", sig);

  draw = await program.account.draw.fetch(drawState);

  console.log("\n=== STATUS DEPOIS ===");
  console.log("status:", toNumberSafe(draw.status));
  console.log("isPaid:", !!(draw.isPaid ?? draw.is_paid));
  console.log("ticketsPaid:", toNumberSafe(draw.ticketsPaid ?? draw.tickets_paid));
}

main().catch((err) => {
  console.error("Erro:", err);
  process.exit(1);
});

