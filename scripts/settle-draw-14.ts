import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
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

async function fetchDraw(program: Program<any>, drawState: PublicKey) {
  return await program.account.draw.fetch(drawState);
}

async function trySettle(
  program: Program<any>,
  admin: anchor.web3.Keypair,
  globalState: PublicKey,
  drawState: PublicKey,
  batchSize: number
) {
  const bnBatch = new anchor.BN(batchSize);

  try {
    const sig = await program.methods
      .settleTickets(bnBatch)
      .accounts({
        admin: admin.publicKey,
        globalState,
        draw: drawState,
      })
      .rpc();

    return sig;
  } catch (err1) {
    try {
      const sig = await program.methods
        .settleTickets(bnBatch)
        .accounts({
          globalState,
          draw: drawState,
        })
        .rpc();

      return sig;
    } catch (err2) {
      throw err2;
    }
  }
}

async function main() {
  console.log("=== MegaByt Settle Draw 14 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const program = anchor.workspace.Megabyt as Program<any>;

  const globalState = new PublicKey("EM4tBuJCFjRd2BLMs61fG6Gh1Q7pEmanJTUyYdoUg1Ln");
  const drawState = new PublicKey("3aXXSmikAyPJ6mgFpcea6d3XUvCbN1E1DBFvFuyf4eHt");

  const BATCH_SIZE = 25;
  const MAX_ROUNDS = 20;

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);
  console.log("GlobalState:", globalState.toBase58());
  console.log("Draw:", drawState.toBase58());
  console.log("Batch size:", BATCH_SIZE);

  let draw = await fetchDraw(program, drawState);

  console.log("=== STATUS INICIAL ===");
  console.log("status:", toNumberSafe(draw.status));
  console.log("isClosed:", !!draw.isClosed);
  console.log("settled:", !!draw.settled);
  console.log("settlementComplete:", !!draw.settlementComplete);
  console.log("ticketsSold:", toNumberSafe(draw.ticketsSold));
  console.log("ticketsProcessed:", toNumberSafe(draw.ticketsProcessed));

  if (!draw.isClosed) {
    throw new Error("A draw ainda não está fechada. Pare aqui.");
  }

  if (draw.settlementComplete || draw.settled) {
    console.log("A draw já está liquidada/apurada. Nada para fazer.");
    return;
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n=== ROUND ${round} ===`);

    const beforeProcessed = toNumberSafe(draw.ticketsProcessed);
    const beforeSold = toNumberSafe(draw.ticketsSold);

    console.log("Antes -> status:", toNumberSafe(draw.status));
    console.log("Antes -> ticketsProcessed:", beforeProcessed);
    console.log("Antes -> ticketsSold:", beforeSold);
    console.log("Antes -> settlementComplete:", !!draw.settlementComplete);
    console.log("Antes -> settled:", !!draw.settled);

    const sig = await trySettle(program, admin, globalState, drawState, BATCH_SIZE);
    console.log("settleTickets tx:", sig);

    await sleep(2500);

    draw = await fetchDraw(program, drawState);

    const afterProcessed = toNumberSafe(draw.ticketsProcessed);
    const afterSold = toNumberSafe(draw.ticketsSold);

    console.log("Depois -> status:", toNumberSafe(draw.status));
    console.log("Depois -> ticketsProcessed:", afterProcessed);
    console.log("Depois -> ticketsSold:", afterSold);
    console.log("Depois -> settlementComplete:", !!draw.settlementComplete);
    console.log("Depois -> settled:", !!draw.settled);

    if (draw.settlementComplete || draw.settled || afterProcessed >= afterSold) {
      console.log("\n=== APURAÇÃO CONCLUÍDA ===");
      console.log("status final:", toNumberSafe(draw.status));
      console.log("ticketsProcessed final:", afterProcessed);
      console.log("ticketsSold final:", afterSold);
      console.log("settlementComplete final:", !!draw.settlementComplete);
      console.log("settled final:", !!draw.settled);
      return;
    }

    if (afterProcessed === beforeProcessed) {
      console.log("Nenhum avanço neste round. Encerrando para evitar loop cego.");
      console.log("status atual:", toNumberSafe(draw.status));
      console.log("ticketsProcessed atual:", afterProcessed);
      console.log("ticketsSold atual:", afterSold);
      return;
    }
  }

  draw = await fetchDraw(program, drawState);

  console.log("\n=== LIMITE DE ROUNDS ATINGIDO ===");
  console.log("status final:", toNumberSafe(draw.status));
  console.log("ticketsProcessed final:", toNumberSafe(draw.ticketsProcessed));
  console.log("ticketsSold final:", toNumberSafe(draw.ticketsSold));
  console.log("settlementComplete final:", !!draw.settlementComplete);
  console.log("settled final:", !!draw.settled);
}

main().catch((err) => {
  console.error("Erro:", err);
  process.exit(1);
});

