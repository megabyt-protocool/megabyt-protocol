import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  console.log("=== MegaByt Settle Draw 2 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace.Megabyt as Program<any>;

  const globalState = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");
  const drawState = new PublicKey("FQzQTu9YVgd1D2BcXQcsHVK3asUiQaPxcstBCtH3u5GT");

  const BATCH_SIZE = 25;
  const MAX_ROUNDS = 20;

  console.log("Admin:", wallet.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);
  console.log("Draw:", drawState.toBase58());

  let draw = await program.account.draw.fetch(drawState);

  console.log("\n=== STATUS INICIAL ===");
  console.log("status:", toNumberSafe(draw.status));
  console.log("ticketsSold:", toNumberSafe(draw.ticketsSold));
  console.log("ticketsProcessed:", toNumberSafe(draw.ticketsProcessed));
  console.log("settlementComplete:", draw.settlementComplete);

  if (!draw.isClosed) {
    throw new Error("Draw ainda não está fechada");
  }

  for (let i = 1; i <= MAX_ROUNDS; i++) {
    console.log(`\n=== ROUND ${i} ===`);

    const before = toNumberSafe(draw.ticketsProcessed);

    const sig = await program.methods
      .settleTickets(new BN(BATCH_SIZE))
      .accounts({
        globalState,
        draw: drawState,
      })
      .rpc();

    console.log("TX:", sig);

    await sleep(2500);

    draw = await program.account.draw.fetch(drawState);

    const after = toNumberSafe(draw.ticketsProcessed);

    console.log("ticketsProcessed:", after);
    console.log("ticketsSold:", toNumberSafe(draw.ticketsSold));
    console.log("settlementComplete:", draw.settlementComplete);

    if (draw.settlementComplete || after >= toNumberSafe(draw.ticketsSold)) {
      console.log("\n🔥 APURAÇÃO FINALIZADA");
      return;
    }

    if (after === before) {
      console.log("⚠️ Sem progresso, parando");
      return;
    }
  }
}

main().catch(console.error);

