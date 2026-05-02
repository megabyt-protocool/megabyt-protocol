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
  console.log("=== MegaByt Pay Draw 2 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace.Megabyt as Program<any>;

  const globalState = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");
  const drawState = new PublicKey("FQzQTu9YVgd1D2BcXQcsHVK3asUiQaPxcstBCtH3u5GT");
  const prizeVault = new PublicKey("8sEKCpLjLLZzRjwKXfn5ubYhuJu2jdYFa5ngqbTyw7mz");
  const vaultAuthority = new PublicKey("5Xb9XSLMwCpDVmiC91H7k7gTeGbfSgm9DjRkVaBnmxxF");

  const ticket = new PublicKey("4gCCpxG8PCsJHtFd31DGeHQ4MGw5asRm6RM58VhRHNsb");
  const userTokenAccount = new PublicKey("Gh8iKdUwXmHEaFqKMErLyicU57NyPb9QqUw1yWxForKS");

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

