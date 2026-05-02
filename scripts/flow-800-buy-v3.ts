import * as anchor from "@coral-xyz/anchor";
import { BN } from "bn.js";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";

const RPC_URL = "https://api.devnet.solana.com";
const TOTAL_TICKETS = 800;
const BATCH_SIZE = 10;
const AIRDROP_PER_WALLET_SOL = 0.02;
const TICKET_PRICE_USDT = 1_000_000; // 1 USDT com 6 decimais

const GLOBAL_STATE_V3 = new PublicKey("FMvkTjV9sZoy1RSptLMGenwXModkK8EF863vUrxBFRqS");
const VAULT_AUTHORITY_V3 = new PublicKey("FUGvd9WbgCDdHLfGcYcZdceockDsiCGqkWNyC17wHHig");
const PRIZE_VAULT_V3 = new PublicKey("F1u75nQvBa3rMHy68LT7XqrpAcAJfMwMuMbyNa2LfKYg");
const USDT_MINT = new PublicKey("DrU7nXTTPFzXqv9xBuoVtUznk92BTWK5U9uAuBBCxWnR");
const BYTI_MINT = new PublicKey("3RvET9pLZCb6bmsiw23XhMbrLgtjvuGQAfuRG3SjUjWc");

const DRAW_SEED = "draw-v3";
const TICKET_SEED = "ticket";
const FORCED_DRAW_ID = 6;

type IdlWithAddress = anchor.Idl & { address?: string };

type GeneratedTicket = {
  numbers: number[];
  crypto: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function toUtf8Bytes(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

function u64le(n: number | BN): Buffer {
  const bn = BN.isBN(n) ? n : new BN(n);
  return bn.toArrayLike(Buffer, "le", 8);
}

function randomUniqueNumbers(max: number, count: number): number[] {
  const set = new Set<number>();
  while (set.size < count) {
    const n = Math.floor(Math.random() * max) + 1;
    set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function generateTicket(): GeneratedTicket {
  return {
    numbers: randomUniqueNumbers(72, 6),
    crypto: Math.floor(Math.random() * 10) + 1,
  };
}

async function sendSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  solAmount: number
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
    })
  );

  return await sendAndConfirmTransaction(connection, tx, [from], {
    commitment: "confirmed",
  });
}

async function sendUsdt(
  connection: Connection,
  admin: Keypair,
  adminUsdtAta: PublicKey,
  destUsdtAta: PublicKey,
  amount: number
) {
  const tx = new Transaction().add(
    createTransferInstruction(
      adminUsdtAta,
      destUsdtAta,
      admin.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  return await sendAndConfirmTransaction(connection, tx, [admin], {
    commitment: "confirmed",
  });
}

async function main() {
  console.log("=== MegaByt 800 Tickets Buy Flow V3 ===");

  const connection = new Connection(RPC_URL, "confirmed");

  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.join(process.env.HOME || "", ".config/solana/id.json");

  const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(secret));

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(admin),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const idlPath = path.join(process.cwd(), "target", "idl", "megabyt.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as IdlWithAddress;

  if (!idl.address) {
    throw new Error("IDL sem address.");
  }

  const programId = new PublicKey(idl.address);
  const program = new anchor.Program(idl, provider);

  console.log("Admin wallet:", admin.publicKey.toBase58());
  console.log("Program:", programId.toBase58());
  console.log("RPC:", RPC_URL);

  const adminBalance = await connection.getBalance(admin.publicKey);
  console.log("Admin balance:", adminBalance / LAMPORTS_PER_SOL, "SOL");

  const adminUsdtAta = getAssociatedTokenAddressSync(USDT_MINT, admin.publicKey);
  const adminBytiAta = getAssociatedTokenAddressSync(BYTI_MINT, admin.publicKey);

  console.log("GlobalState v3:", GLOBAL_STATE_V3.toBase58());
  console.log("Vault authority v3:", VAULT_AUTHORITY_V3.toBase58());
  console.log("Prize vault v3:", PRIZE_VAULT_V3.toBase58());
  console.log("USDT mint:", USDT_MINT.toBase58());
  console.log("BYTI mint:", BYTI_MINT.toBase58());
  console.log("Admin USDT ATA:", adminUsdtAta.toBase58());
  console.log("Admin BYTI ATA:", adminBytiAta.toBase58());

  const globalRaw = await connection.getAccountInfo(GLOBAL_STATE_V3);
  if (!globalRaw) {
    throw new Error("GlobalState v3 não encontrado na devnet.");
  }

  const coder = new anchor.BorshAccountsCoder(idl);
  const globalDecoded: any = coder.decode("GlobalState", globalRaw.data);

  console.log("\n=== GLOBAL STATE CHECK ===");
  console.log("current_draw_id on-chain:", Number(globalDecoded.current_draw_id ?? 0));
  console.log("total_draws on-chain:", Number(globalDecoded.total_draws ?? 0));

  const [drawPda] = PublicKey.findProgramAddressSync(
    [toUtf8Bytes(DRAW_SEED), u64le(FORCED_DRAW_ID)],
    programId
  );

  console.log("\n=== FORCED DRAW CONFIG ===");
  console.log("FORCED_DRAW_ID:", FORCED_DRAW_ID);
  console.log("DRAW_SEED:", DRAW_SEED);
  console.log("Draw PDA:", drawPda.toBase58());

  const drawInfo = await connection.getAccountInfo(drawPda);
  if (!drawInfo) {
    throw new Error(
      `Draw ${FORCED_DRAW_ID} não encontrada on-chain. PDA: ${drawPda.toBase58()}`
    );
  }

  const drawDecoded: any = coder.decode("Draw", drawInfo.data);

  console.log("\n=== DRAW CHECK ===");
  console.log("Draw carregada:", drawPda.toBase58());
  console.log("status:", Number(drawDecoded.status ?? 0));
  console.log("ticketsSold atual:", Number(drawDecoded.tickets_sold ?? drawDecoded.ticketsSold ?? 0));
  console.log("isOpen:", !!drawDecoded.is_open ?? !!drawDecoded.isOpen);
  console.log("isClosed:", !!drawDecoded.is_closed ?? !!drawDecoded.isClosed);

  const isOpen =
    typeof drawDecoded.is_open !== "undefined"
      ? !!drawDecoded.is_open
      : !!drawDecoded.isOpen;

  if (!isOpen) {
    throw new Error("A draw 6 não está aberta. Não dá para comprar tickets.");
  }

  console.log("\n=== STEP 1: Preparing 800 player wallets ===");
  const players: Keypair[] = Array.from({ length: TOTAL_TICKETS }, () => Keypair.generate());
  const tickets: GeneratedTicket[] = Array.from({ length: TOTAL_TICKETS }, () => generateTicket());

  console.log("Wallets geradas:", players.length);
  console.log("Tickets gerados:", tickets.length);
  console.log("Batch size:", BATCH_SIZE);

  console.log("\n=== STEP 2: Funding SOL + USDT for players ===");
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    const playerUsdtAta = getAssociatedTokenAddressSync(USDT_MINT, player.publicKey);

    try {
      await sendSol(connection, admin, player.publicKey, AIRDROP_PER_WALLET_SOL);

      await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        USDT_MINT,
        player.publicKey,
        false,
        "confirmed"
      );

      await sendUsdt(connection, admin, adminUsdtAta, playerUsdtAta, TICKET_PRICE_USDT);

      if ((i + 1) % 25 === 0 || i === players.length - 1) {
        console.log(`Funding progress: ${i + 1}/${players.length}`);
      }

      await sleep(250);
    } catch (e: any) {
      console.log(`Erro ao fundear wallet ${i + 1}:`, e?.message || e);
      throw e;
    }
  }

  console.log("\n=== STEP 3: Buying 800 tickets ===");

  const buyBatches = chunkArray(
    players.map((player, idx) => ({
      player,
      ticket: tickets[idx],
      idx,
    })),
    BATCH_SIZE
  );

  let success = 0;
  let failed = 0;

  for (let batchIndex = 0; batchIndex < buyBatches.length; batchIndex++) {
    const batch = buyBatches[batchIndex];

    console.log(`\n--- Batch ${batchIndex + 1}/${buyBatches.length} ---`);

    for (const item of batch) {
      const { player, ticket, idx } = item;

      const playerUsdtAta = getAssociatedTokenAddressSync(USDT_MINT, player.publicKey);

      const [ticketPda] = PublicKey.findProgramAddressSync(
        [
          toUtf8Bytes(TICKET_SEED),
          drawPda.toBuffer(),
          player.publicKey.toBuffer(),
        ],
        programId
      );

      try {
        const sig = await (program.methods as any)
          .buyTicket(ticket.numbers, ticket.crypto)
          .accounts({
            globalState: GLOBAL_STATE_V3,
            drawState: drawPda,
            ticket: ticketPda,
            user: player.publicKey,
            userTokenAccount: playerUsdtAta,
            prizeVault: PRIZE_VAULT_V3,
            vaultAuthority: VAULT_AUTHORITY_V3,
            usdtMint: USDT_MINT,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();

        success++;
        console.log(
          `OK #${idx + 1} | ${player.publicKey.toBase58()} | numbers=${ticket.numbers.join(",")} | crypto=${ticket.crypto} | sig=${sig}`
        );
      } catch (e: any) {
        failed++;
        console.log(
          `FAIL #${idx + 1} | ${player.publicKey.toBase58()} | motivo=${e?.message || e}`
        );
      }

      await sleep(400);
    }

    console.log(
      `Batch ${batchIndex + 1} concluído | success=${success} | failed=${failed}`
    );

    await sleep(2000);
  }

  console.log("\n=== STEP 4: Final draw check ===");

  const finalDrawInfo = await connection.getAccountInfo(drawPda);
  if (!finalDrawInfo) {
    throw new Error("Draw sumiu ao final, o que não era esperado.");
  }

  const finalDraw: any = coder.decode("Draw", finalDrawInfo.data);

  const finalTicketsSold =
    typeof finalDraw.tickets_sold !== "undefined"
      ? Number(finalDraw.tickets_sold)
      : Number(finalDraw.ticketsSold ?? 0);

  const finalTicketsProcessed =
    typeof finalDraw.tickets_processed !== "undefined"
      ? Number(finalDraw.tickets_processed)
      : Number(finalDraw.ticketsProcessed ?? 0);

  const finalSettlementComplete =
    typeof finalDraw.settlement_complete !== "undefined"
      ? !!finalDraw.settlement_complete
      : !!finalDraw.settlementComplete;

  const finalRandomnessRequested =
    typeof finalDraw.randomness_requested !== "undefined"
      ? !!finalDraw.randomness_requested
      : !!finalDraw.randomnessRequested;

  const finalRandomnessFulfilled =
    typeof finalDraw.randomness_fulfilled !== "undefined"
      ? !!finalDraw.randomness_fulfilled
      : !!finalDraw.randomnessFulfilled;

  const finalIsOpen =
    typeof finalDraw.is_open !== "undefined"
      ? !!finalDraw.is_open
      : !!finalDraw.isOpen;

  const finalIsClosed =
    typeof finalDraw.is_closed !== "undefined"
      ? !!finalDraw.is_closed
      : !!finalDraw.isClosed;

  console.log("Draw:", drawPda.toBase58());
  console.log("status:", Number(finalDraw.status ?? 0));
  console.log("isOpen:", finalIsOpen);
  console.log("isClosed:", finalIsClosed);
  console.log("ticketsSold:", finalTicketsSold);
  console.log("ticketsProcessed:", finalTicketsProcessed);
  console.log("settlementComplete:", finalSettlementComplete);
  console.log("randomnessRequested:", finalRandomnessRequested);
  console.log("randomnessFulfilled:", finalRandomnessFulfilled);

  const out = {
    rpc: RPC_URL,
    programId: programId.toBase58(),
    admin: admin.publicKey.toBase58(),
    globalState: GLOBAL_STATE_V3.toBase58(),
    draw: drawPda.toBase58(),
    forcedDrawId: FORCED_DRAW_ID,
    totals: {
      requested: TOTAL_TICKETS,
      success,
      failed,
      finalTicketsSold,
    },
    players: players.map((p, i) => ({
      index: i + 1,
      wallet: p.publicKey.toBase58(),
      secretKey: Array.from(p.secretKey),
      numbers: tickets[i].numbers,
      crypto: tickets[i].crypto,
    })),
  };

  const outFile = path.join(process.cwd(), "scripts", "flow-800-buy-v3-result.json");
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log("\nArquivo salvo:", outFile);
  console.log("\n=== DONE ===");
  console.log("requested:", TOTAL_TICKETS);
  console.log("success:", success);
  console.log("failed:", failed);
  console.log("draw:", drawPda.toBase58());
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});

