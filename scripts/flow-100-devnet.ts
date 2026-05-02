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
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

type TicketPlan = {
  numbers: number[];
  crypto: number;
};

type PlayerEntry = {
  player: Keypair;
  ata: PublicKey;
  ticket: PublicKey;
  plan: TicketPlan;
};

const TARGET_TICKETS = Number(process.env.TICKETS ?? "300");
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "10");
const DRAW_DURATION_SECONDS = Number(process.env.DRAW_DURATION_SECONDS ?? "3600");
const PLAYER_SOL_FUND = Number(process.env.PLAYER_SOL_FUND ?? "0.003");
const CANDIDATES_PER_TICKET = Number(process.env.CANDIDATES_PER_TICKET ?? "1200");
const PAUSE_BETWEEN_BATCHES_MS = Number(process.env.PAUSE_BETWEEN_BATCHES_MS ?? "1200");
const PAUSE_BETWEEN_TX_MS = Number(process.env.PAUSE_BETWEEN_TX_MS ?? "120");
const COMMITMENT: anchor.web3.Commitment = "confirmed";

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

  console.log(`Duplas restantes após planejamento: ${uncoveredPairs.size}`);

  const outDir = path.join(process.cwd(), "artifacts_batches");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, `ticket-plan-${targetTickets}.json`),
    JSON.stringify(
      {
        targetTickets,
        batchSize: BATCH_SIZE,
        remainingPairs: uncoveredPairs.size,
        plans,
      },
      null,
      2
    )
  );

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
  const sig = await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: COMMITMENT,
  });
  return sig;
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

  const currentDrawId = Number(
    globalStateAccount.currentDrawId ?? globalStateAccount.current_draw_id ?? 0
  );

  if (currentDrawId > 0) {
    const [currentDrawPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("draw-v3"), new BN(currentDrawId).toArrayLike(Buffer, "le", 8)],
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
      // segue para abrir próxima
    }
  }

  const nextDrawId = currentDrawId + 1;
  const [nextDrawPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), new BN(nextDrawId).toArrayLike(Buffer, "le", 8)],
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

async function main() {
  console.log("=== MegaByt Batch Buy Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const admin = wallet.payer;
  const program = anchor.workspace.Megabyt as Program;

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);

  const adminBalance = await connection.getBalance(admin.publicKey, COMMITMENT);
  console.log("Admin balance:", adminBalance / LAMPORTS_PER_SOL, "SOL");

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")],
    program.programId
  );

  console.log("GlobalState PDA:", globalState.toBase58());

  const globalStateAccount: any = await getGlobalStateAccount(program, globalState);

  const usdtMint: PublicKey =
    globalStateAccount.usdtMint ??
    globalStateAccount.usdt_mint ??
    globalStateAccount.tokenMint ??
    globalStateAccount.token_mint;

  if (!usdtMint) {
    throw new Error("Não consegui encontrar usdtMint/tokenMint no GlobalState.");
  }

  const prizeVault: PublicKey =
    globalStateAccount.prizeVault ??
    globalStateAccount.prize_vault;

  if (!prizeVault) {
    throw new Error("Não consegui encontrar prizeVault no GlobalState.");
  }

  const ticketPriceRaw =
    globalStateAccount.ticketPrice ??
    globalStateAccount.ticket_price;

  if (ticketPriceRaw === undefined || ticketPriceRaw === null) {
    throw new Error("Não consegui encontrar ticketPrice no GlobalState.");
  }

  const ticketPrice = BigInt(ticketPriceRaw.toString());

  console.log("USDT mint:", usdtMint.toBase58());
  console.log("Prize vault:", prizeVault.toBase58());
  console.log("Ticket price (raw):", ticketPrice.toString());

  const { draw, drawIdUsed, reused } = await findOrCreateOpenDraw(program, admin, globalState);
  console.log(`Using draw id=${drawIdUsed} | reused=${reused} | draw=${draw.toBase58()}`);

  const plans = buildGreedyTickets(TARGET_TICKETS);
  const players: PlayerEntry[] = [];

  const lamportsPerPlayer = Math.floor(PLAYER_SOL_FUND * LAMPORTS_PER_SOL);
  const estimatedLamports = lamportsPerPlayer * TARGET_TICKETS;
  console.log("SOL por player:", PLAYER_SOL_FUND);
  console.log("Estimativa SOL total para funding:", estimatedLamports / LAMPORTS_PER_SOL);

  for (let start = 0; start < TARGET_TICKETS; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, TARGET_TICKETS);
    const batchPlans = plans.slice(start, end);

    console.log(`\n=== Batch ${Math.floor(start / BATCH_SIZE) + 1} | tickets ${start + 1}-${end} ===`);

    for (let i = 0; i < batchPlans.length; i++) {
      const idx = start + i;
      const plan = batchPlans[i];
      const player = Keypair.generate();

      console.log(
        `Ticket ${idx + 1}/${TARGET_TICKETS} | player=${player.publicKey.toBase58()} | numbers=${plan.numbers.join(",")} | crypto=${plan.crypto}`
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

      const ataInfoBefore = await getAccount(connection, ata.address, COMMITMENT);
      if (ataInfoBefore.amount < ticketPrice) {
        const missing = ticketPrice - ataInfoBefore.amount;
        await mintExactToAta(connection, admin, usdtMint, ata.address, missing);
      }

      const [ticket] = PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), draw.toBuffer(), player.publicKey.toBuffer()],
        program.programId
      );

      await (program.methods as any)
        .buyTicket(plan.numbers, plan.crypto)
        .accounts({
          user: player.publicKey,
          globalState,
          drawState: draw,
          ticket,
          userTokenAccount: ata.address,
          prizeVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();

      players.push({
        player,
        ata: ata.address,
        ticket,
        plan,
      });

      await sleep(PAUSE_BETWEEN_TX_MS);
    }

    const soldSoFar = players.length;
    console.log(`Batch concluído. Tickets comprados até agora: ${soldSoFar}/${TARGET_TICKETS}`);

    const outDir = path.join(process.cwd(), "artifacts_batches");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `players-draw-${drawIdUsed}-partial-${soldSoFar}.json`),
      JSON.stringify(
        {
          drawId: drawIdUsed,
          draw: draw.toBase58(),
          soldSoFar,
          players: players.map((p) => ({
            player: Array.from(p.player.secretKey),
            playerPubkey: p.player.publicKey.toBase58(),
            ata: p.ata.toBase58(),
            ticket: p.ticket.toBase58(),
            numbers: p.plan.numbers,
            crypto: p.plan.crypto,
          })),
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
  console.log("Total tickets bought:", players.length);
  console.log("Admin balance before:", adminBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Admin balance after:", finalBalance / LAMPORTS_PER_SOL, "SOL");
  console.log(
    "Arquivo players salvo em:",
    path.join(process.cwd(), "artifacts_batches", `players-draw-${drawIdUsed}-partial-${players.length}.json`)
  );
}

main().catch((err) => {
  console.error("Batch flow failed:");
  console.error(err);
  process.exit(1);
});

