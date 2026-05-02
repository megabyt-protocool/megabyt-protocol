import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createMintToInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const TOTAL_TICKETS = 300;
const BATCH_SIZE = 10;
const DRAW_DURATION_SECONDS = 3600;
const PLAYER_SOL_FUND = 0.003;
const PAUSE_BETWEEN_TX_MS = 120;
const PAUSE_BETWEEN_BATCHES_MS = 1200;
const COMMITMENT: anchor.web3.Commitment = "confirmed";

type TicketPlan = {
  numbers: number[];
  crypto: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sampleUniqueNumbers(max: number, count: number): number[] {
  return shuffle(Array.from({ length: max }, (_, i) => i + 1))
    .slice(0, count)
    .sort((a, b) => a - b);
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function countNewPairs(numbers: number[], uncoveredPairs: Set<string>): number {
  let score = 0;
  for (let i = 0; i < numbers.length; i++) {
    for (let j = i + 1; j < numbers.length; j++) {
      if (uncoveredPairs.has(pairKey(numbers[i], numbers[j]))) score++;
    }
  }
  return score;
}

function buildGreedyTickets(targetTickets: number): TicketPlan[] {
  const uncoveredPairs = new Set<string>();
  for (let a = 1; a <= 72; a++) {
    for (let b = a + 1; b <= 72; b++) {
      uncoveredPairs.add(pairKey(a, b));
    }
  }

  const plans: TicketPlan[] = [];
  const CANDIDATES_PER_TICKET = 1200;

  for (let t = 0; t < targetTickets; t++) {
    let bestNumbers = sampleUniqueNumbers(72, 6);
    let bestScore = -1;

    for (let c = 0; c < CANDIDATES_PER_TICKET; c++) {
      const candidate = sampleUniqueNumbers(72, 6);
      const score = countNewPairs(candidate, uncoveredPairs);
      if (score > bestScore) {
        bestScore = score;
        bestNumbers = candidate;
        if (bestScore === 15) break;
      }
    }

    for (let i = 0; i < bestNumbers.length; i++) {
      for (let j = i + 1; j < bestNumbers.length; j++) {
        uncoveredPairs.delete(pairKey(bestNumbers[i], bestNumbers[j]));
      }
    }

    plans.push({
      numbers: bestNumbers,
      crypto: 1 + (t % 10),
    });

    if ((t + 1) % 10 === 0 || t === targetTickets - 1) {
      console.log(
        `Plano gerado: ${t + 1}/${targetTickets} | duplas ainda não cobertas: ${uncoveredPairs.size}`
      );
    }
  }

  const outDir = path.join(process.cwd(), "artifacts_batches");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, `ticket-plan-${targetTickets}.json`),
    JSON.stringify(
      {
        targetTickets,
        remainingPairs: uncoveredPairs.size,
        plans,
      },
      null,
      2
    )
  );

  console.log(`Duplas restantes após planejamento: ${uncoveredPairs.size}`);
  return plans;
}

async function mintExactToAta(
  connection: anchor.web3.Connection,
  payer: Keypair,
  mint: PublicKey,
  destinationAta: PublicKey,
  amount: bigint
) {
  const ix = createMintToInstruction(
    mint,
    destinationAta,
    payer.publicKey,
    amount,
    [],
    TOKEN_PROGRAM_ID
  );

  const tx = new Transaction().add(ix);
  return await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: COMMITMENT,
  });
}

async function fundPlayer(
  connection: anchor.web3.Connection,
  admin: Keypair,
  player: PublicKey,
  lamports: number
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: player,
      lamports,
    })
  );

  return await anchor.web3.sendAndConfirmTransaction(connection, tx, [admin], {
    commitment: COMMITMENT,
  });
}

async function getGlobalStateAccount(program: Program, globalState: PublicKey): Promise<any> {
  return await (program.account as any).globalState.fetch(globalState);
}

async function findOrCreateOpenDraw(
  program: Program,
  admin: Keypair,
  globalState: PublicKey
): Promise<{ draw: PublicKey; drawIdUsed: number; reused: boolean }> {
  const globalStateAccount: any = await getGlobalStateAccount(program, globalState);
  const currentDrawId = Number(globalStateAccount.currentDrawId ?? globalStateAccount.current_draw_id ?? 0);

  if (currentDrawId > 0) {
    const [currentDrawPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("draw"), new BN(currentDrawId).toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      const existingDraw: any = await (program.account as any).draw.fetch(currentDrawPda);
      const isOpen = Boolean(existingDraw.isOpen ?? existingDraw.is_open);
      const isClosed = Boolean(existingDraw.isClosed ?? existingDraw.is_closed);

      if (isOpen && !isClosed) {
        console.log(`Reutilizando draw aberta id=${currentDrawId}: ${currentDrawPda.toBase58()}`);
        return { draw: currentDrawPda, drawIdUsed: currentDrawId, reused: true };
      }
    } catch {
      // segue para abrir nova
    }
  }

  const nextDrawId = currentDrawId + 1;
  const [nextDrawPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw"), new BN(nextDrawId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  console.log(`Abrindo nova draw id=${nextDrawId}: ${nextDrawPda.toBase58()}`);

  await (program.methods as any)
    .openDraw(new BN(DRAW_DURATION_SECONDS))
    .accounts({
      admin: admin.publicKey,
      globalState,
      drawState: nextDrawPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();

  return { draw: nextDrawPda, drawIdUsed: nextDrawId, reused: false };
}

(async () => {
  console.log("=== MegaByt 300 Tickets (Batch 10) ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const admin = wallet.payer;
  const program = anchor.workspace.Megabyt as Program;

  console.log("Admin wallet:", admin.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);

  const adminBalance = await connection.getBalance(admin.publicKey, COMMITMENT);
  console.log("Admin balance:", adminBalance / LAMPORTS_PER_SOL, "SOL");

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v2")],
    program.programId
  );

  console.log("GlobalState:", globalState.toBase58());

  const global: any = await getGlobalStateAccount(program, globalState);

  const usdtMint: PublicKey =
    global.usdtMint ??
    global.usdt_mint ??
    global.tokenMint ??
    global.token_mint;

  const prizeVault: PublicKey =
    global.prizeVault ??
    global.prize_vault;

  const ticketPriceRaw =
    global.ticketPrice ??
    global.ticket_price;

  if (!usdtMint || !prizeVault || ticketPriceRaw === undefined || ticketPriceRaw === null) {
    throw new Error("GlobalState não trouxe usdtMint/prizeVault/ticketPrice.");
  }

  const ticketPrice = BigInt(ticketPriceRaw.toString());

  console.log("USDT mint:", usdtMint.toBase58());
  console.log("Prize vault:", prizeVault.toBase58());
  console.log("Ticket price:", ticketPrice.toString());

  const { draw, drawIdUsed, reused } = await findOrCreateOpenDraw(program, admin, globalState);
  console.log(`Draw usada: ${draw.toBase58()} | drawId=${drawIdUsed} | reused=${reused}`);

  const plans = buildGreedyTickets(TOTAL_TICKETS);
  const playersOut: any[] = [];

  const lamportsPerPlayer = Math.floor(PLAYER_SOL_FUND * LAMPORTS_PER_SOL);
  console.log("SOL por wallet:", PLAYER_SOL_FUND);

  let bought = 0;

  for (let start = 0; start < TOTAL_TICKETS; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, TOTAL_TICKETS);
    const batchPlans = plans.slice(start, end);

    console.log(`\n=== Batch ${Math.floor(start / BATCH_SIZE) + 1} | tickets ${start + 1}-${end} ===`);

    for (let i = 0; i < batchPlans.length; i++) {
      const idx = start + i;
      const plan = batchPlans[i];
      const player = Keypair.generate();

      console.log(
        `Ticket ${idx + 1}/${TOTAL_TICKETS} | player=${player.publicKey.toBase58()} | numbers=${plan.numbers.join(",")} | crypto=${plan.crypto}`
      );

      await fundPlayer(connection, admin, player.publicKey, lamportsPerPlayer);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        usdtMint,
        player.publicKey,
        false,
        COMMITMENT
      );

      const ataInfo = await getAccount(connection, ata.address, COMMITMENT);
      if (ataInfo.amount < ticketPrice) {
        const missing = ticketPrice - ataInfo.amount;
        await mintExactToAta(connection, admin, usdtMint, ata.address, missing);
      }

      const [ticketPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("ticket"),
          draw.toBuffer(),
          player.publicKey.toBuffer(),
        ],
        program.programId
      );

      await (program.methods as any)
        .buyTicket(plan.numbers, plan.crypto)
        .accounts({
          user: player.publicKey,
          globalState,
          drawState: draw,
          ticket: ticketPda,
          userTokenAccount: ata.address,
          prizeVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();

      playersOut.push({
        playerPubkey: player.publicKey.toBase58(),
        secretKey: Array.from(player.secretKey),
        ata: ata.address.toBase58(),
        ticket: ticketPda.toBase58(),
        numbers: plan.numbers,
        crypto: plan.crypto,
      });

      bought++;
      await sleep(PAUSE_BETWEEN_TX_MS);
    }

    console.log(`Batch concluído. Tickets comprados: ${bought}/${TOTAL_TICKETS}`);

    const outDir = path.join(process.cwd(), "artifacts_batches");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `players-draw-${drawIdUsed}-partial-${bought}.json`),
      JSON.stringify(
        {
          drawId: drawIdUsed,
          draw: draw.toBase58(),
          bought,
          players: playersOut,
        },
        null,
        2
      )
    );

    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  const finalBalance = await connection.getBalance(admin.publicKey, COMMITMENT);

  console.log("\n=== FINAL SUMMARY ===");
  console.log("Draw ID:", drawIdUsed);
  console.log("Draw:", draw.toBase58());
  console.log("Total tickets bought:", bought);
  console.log("Admin balance before:", adminBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Admin balance after:", finalBalance / LAMPORTS_PER_SOL, "SOL");
})().catch((err) => {
  console.error("Flow failed:");
  console.error(err);
  process.exit(1);
});

