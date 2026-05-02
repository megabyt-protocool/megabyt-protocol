import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const EXPECTED_PROGRAM_ID = new PublicKey("Gv3ZyzmkbqaH3m8HJ9c4hX3ozc9Lb5gM7xWsqxMvGEos");
const GLOBAL_STATE_SEED = "global-state-v3";
const RANDOMNESS_KEYPAIR_PATH = path.resolve("scripts/megabyt-randomness-keypair.json");

const TARGET_DRAW_ID = 1;
const TARGET_TOTAL_TICKETS = 100;

function loadOrCreateRandomnessKeypair() {
  if (fs.existsSync(RANDOMNESS_KEYPAIR_PATH)) {
    const raw = JSON.parse(fs.readFileSync(RANDOMNESS_KEYPAIR_PATH, "utf8"));
    return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(raw));
  }

  const kp = anchor.web3.Keypair.generate();
  fs.writeFileSync(
    RANDOMNESS_KEYPAIR_PATH,
    JSON.stringify(Array.from(kp.secretKey), null, 2)
  );
  return kp;
}

async function accountExists(connection: anchor.web3.Connection, pubkey: PublicKey) {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
}

function readTickets(draw: any): number {
  return Number(
    draw.ticketsSold ??
      draw.tickets_sold ??
      draw.totalTickets ??
      draw.total_tickets ??
      0
  );
}

function readBool(draw: any, a: string, b?: string): boolean {
  return Boolean((draw as any)[a] ?? (b ? (draw as any)[b] : undefined) ?? false);
}

function readStatus(draw: any): number {
  return Number(draw.status ?? 0);
}

function buildCloseDrawComputeIxs() {
  const ixComputeLimit = ComputeBudgetProgram.setComputeUnitLimit({
    units: 600_000,
  });

  const ixComputePrice = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 5_000,
  });

  return [ixComputeLimit, ixComputePrice];
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace.Megabyt as Program;

  console.log(`=== FINALIZAR DRAW ${TARGET_DRAW_ID} ===`);
  console.log("Admin:", wallet.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);

  if (!program.programId.equals(EXPECTED_PROGRAM_ID)) {
    throw new Error(
      `Program ID inesperado. Atual=${program.programId.toBase58()} Esperado=${EXPECTED_PROGRAM_ID.toBase58()}`
    );
  }

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_STATE_SEED)],
    program.programId
  );

  console.log("GlobalState:", globalState.toBase58());

  const globalExists = await accountExists(connection, globalState);
  if (!globalExists) {
    throw new Error("GlobalState v3 não existe");
  }

  await program.account.globalState.fetch(globalState);

  const [drawState] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), new BN(TARGET_DRAW_ID).toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  console.log("Draw:", drawState.toBase58());

  const exists = await accountExists(connection, drawState);
  if (!exists) {
    throw new Error("Draw v3 não existe");
  }

  const draw = await program.account.draw.fetch(drawState);
  const sold = readTickets(draw);
  const isOpen = readBool(draw, "isOpen", "is_open");
  const isClosed = readBool(draw, "isClosed", "is_closed");
  const randomnessRequested = readBool(draw, "randomnessRequested", "randomness_requested");
  const randomnessFulfilled = readBool(draw, "randomnessFulfilled", "randomness_fulfilled");
  const status = readStatus(draw);

  console.log("Tickets atuais:", sold);
  console.log("isOpen:", isOpen);
  console.log("isClosed:", isClosed);
  console.log("randomnessRequested:", randomnessRequested);
  console.log("randomnessFulfilled:", randomnessFulfilled);
  console.log("status:", status);

  if (sold < TARGET_TOTAL_TICKETS) {
    console.log("⚠️ Ainda não bateu a meta, mas vamos seguir mesmo assim...");
  } else {
    console.log("Meta atingida. Seguindo para VRF.");
  }

  if (!isOpen || isClosed || status !== 0) {
    throw new Error(
      `Draw não está em estado válido para requestRandomness. isOpen=${isOpen} isClosed=${isClosed} status=${status}`
    );
  }

  if (randomnessRequested) {
    console.log("Randomness já foi solicitada anteriormente. Pulando request.");
  } else {
    console.log("\n=== Request randomness ===");

    const randomness = loadOrCreateRandomnessKeypair();
    console.log("Randomness account:", randomness.publicKey.toBase58());

    await program.methods
      .requestRandomness()
      .accounts({
        draw: drawState,
        randomnessAccount: randomness.publicKey,
      })
      .rpc();

    console.log("Randomness solicitado");

    console.log("\n=== Aguardando VRF ===");
    await new Promise((r) => setTimeout(r, 15000));

    console.log("\n=== Close draw ===");

    await program.methods
      .closeDraw()
      .accounts({
        globalState,
        draw: drawState,
        randomnessAccountData: randomness.publicKey,
      })
      .preInstructions(buildCloseDrawComputeIxs())
      .rpc();

    console.log("🎉 DRAW FINALIZADA COM SUCESSO");
    return;
  }

  if (!randomnessFulfilled) {
    const randomness = loadOrCreateRandomnessKeypair();

    console.log("\n=== Aguardando VRF já solicitada ===");
    console.log("Randomness account:", randomness.publicKey.toBase58());

    await new Promise((r) => setTimeout(r, 15000));

    console.log("\n=== Close draw ===");

    await program.methods
      .closeDraw()
      .accounts({
        globalState,
        draw: drawState,
        randomnessAccountData: randomness.publicKey,
      })
      .preInstructions(buildCloseDrawComputeIxs())
      .rpc();

    console.log("🎉 DRAW FINALIZADA COM SUCESSO");
    return;
  }

  console.log("Randomness já cumprida e draw aparentemente já avançou. Nada a fazer.");
}

main().catch((err) => {
  console.error("Erro:");
  console.error(err);
  process.exit(1);
});

