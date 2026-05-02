import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
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

const COMMITMENT: anchor.web3.Commitment = "confirmed";

const TARGET_TICKETS = Number(process.env.TICKETS ?? "400");
const DRAW_DURATION_SECONDS = Number(process.env.DRAW_DURATION_SECONDS ?? "3600");
const PLAYER_SOL_FUND = Number(process.env.PLAYER_SOL_FUND ?? "0.003");
const BUY_BATCH_SIZE = Number(process.env.BUY_BATCH_SIZE ?? "5");
const PAUSE_BETWEEN_BATCHES_MS = Number(process.env.PAUSE_BETWEEN_BATCHES_MS ?? "2500");
const PAUSE_AFTER_REQUEST_RANDOMNESS_MS = Number(process.env.PAUSE_AFTER_REQUEST_RANDOMNESS_MS ?? "15000");
const PAUSE_BETWEEN_SETTLE_MS = Number(process.env.PAUSE_BETWEEN_SETTLE_MS ?? "1200");
const SETTLE_BATCH_SIZE = Number(process.env.SETTLE_BATCH_SIZE ?? "25");

const GLOBAL_STATE = new PublicKey("FMvkTjV9sZoy1RSptLMGenwXModkK8EF863vUrxBFRqS");
const PRIZE_VAULT = new PublicKey("F1u75nQvBa3rMHy68LT7XqrpAcAJfMwMuMbyNa2LfKYg");
const VAULT_AUTHORITY = new PublicKey("FUGvd9WbgCDdHLfGcYcZdceockDsiCGqkWNyC17wHHig");
const RANDOMNESS_KEYPAIR_PATH = path.resolve("scripts/megabyt-randomness-keypair.json");

type TicketPlan = {
  pair: [number, number];
  numbers: number[];
  crypto: number;
};

type PlayerEntry = {
  player: Keypair;
  ata: PublicKey;
  ticket: PublicKey;
  plan: TicketPlan;
};

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

function generateAllPairs(max: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let a = 1; a <= max; a++) {
    for (let b = a + 1; b <= max; b++) {
      pairs.push([a, b]);
    }
  }
  return pairs;
}

function buildTicketFromPair(pair: [number, number], index: number): TicketPlan {
  const used = new Set<number>(pair);
  const numbers = [pair[0], pair[1]];

  let cursor = ((index * 11) % 72) + 1;
  let step = ((index * 7) % 17) + 5;

  while (numbers.length < 6) {
    if (cursor > 72) {
      cursor = ((cursor - 1) % 72) + 1;
    }

    if (!used.has(cursor)) {
      used.add(cursor);
      numbers.push(cursor);
    }

    cursor += step;
    step += 1;
  }

  numbers.sort((a, b) => a - b);

  return {
    pair,
    numbers,
    crypto: (index % 10) + 1,
  };
}

function buildAllPairCoveragePlans(): TicketPlan[] {
  const pairs = generateAllPairs(72);
  return pairs.map((pair, index) => buildTicketFromPair(pair, index));
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

function savePlayersSnapshot(drawId: number, draw: PublicKey, players: PlayerEntry[]) {
  const outDir = path.join(process.cwd(), "artifacts_batches");
  fs.mkdirSync(outDir, { recursive: true });

  const payload = {
    drawId,
    draw: draw.toBase58(),
    totalPlayers: players.length,
    players: players.map((p) => ({
      player: Array.from(p.player.secretKey),
      playerPubkey: p.player.publicKey.toBase58(),
      ata: p.ata.toBase58(),
      ticket: p.ticket.toBase58(),
      pair: p.plan.pair,
      numbers: p.plan.numbers,
      crypto: p.plan.crypto,
    })),
  };

  fs.writeFileSync(
    path.join(outDir, `players-draw-${drawId}-stress-${players.length}.json`),
    JSON.stringify(payload, null, 2)
  );

  fs.writeFileSync(
    path.join(outDir, `snapshot_${draw.toBase58()}.json`),
    JSON.stringify(payload, null, 2)
  );
}

async function main() {
  console.log("=== MegaByt Stress 400 Snapshot V3 ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const admin = wallet.payer;
  const program = anchor.workspace.Megabyt as Program<any>;

  const global: any = await program.account.globalState.fetch(GLOBAL_STATE);
  const usdtMint = new PublicKey(
    global.usdtMint ?? global.usdt_mint ?? global.tokenMint ?? global.token_mint
  );
  const ticketPrice = BigInt((global.ticketPrice ?? global.ticket_price).toString());

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);
  console.log("USDT Mint:", usdtMint.toBase58());
  console.log("Ticket price:", ticketPrice.toString());

  const plans = buildAllPairCoveragePlans().slice(0, TARGET_TICKETS);

  const currentDrawId = Number(global.currentDrawId ?? global.current_draw_id ?? 0);
  const nextDrawId = currentDrawId + 1;

  const [drawState] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), new BN(nextDrawId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  console.log("Draw:", drawState.toBase58());

  const existing = await connection.getAccountInfo(drawState);
  if (!existing) {
    const sigOpen = await program.methods
      .openDraw(new BN(DRAW_DURATION_SECONDS))
      .accounts({
        admin: admin.publicKey,
        globalState: GLOBAL_STATE,
        drawState,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc({ commitment: COMMITMENT });

    console.log("openDraw tx:", sigOpen);
  }

  const players: PlayerEntry[] = [];
  const lamportsPerPlayer = Math.floor(PLAYER_SOL_FUND * LAMPORTS_PER_SOL);

  async function processPlan(plan: TicketPlan, i: number): Promise<PlayerEntry | null> {
    const player = Keypair.generate();

    try {
      console.log(
        `Ticket ${i + 1}/${plans.length} | player=${player.publicKey.toBase58()} | numbers=${plan.numbers.join(",")} | crypto=${plan.crypto}`
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

      const [ticket] = PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), drawState.toBuffer(), player.publicKey.toBuffer()],
        program.programId
      );

      const sigBuy = await program.methods
        .buyTicket(plan.numbers, plan.crypto)
        .accounts({
          user: player.publicKey,
          globalState: GLOBAL_STATE,
          drawState,
          ticket,
          userTokenAccount: ata.address,
          prizeVault: PRIZE_VAULT,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc({ commitment: COMMITMENT });

      console.log("buyTicket tx:", sigBuy);

      return {
        player,
        ata: ata.address,
        ticket,
        plan,
      };
    } catch (err: any) {
      console.log(`FAIL ticket ${i + 1}:`, err?.message || err);
      return null;
    }
  }

  console.log("\n=== BUY TICKETS ===");
  for (let start = 0; start < plans.length; start += BUY_BATCH_SIZE) {
    const end = Math.min(start + BUY_BATCH_SIZE, plans.length);
    const chunk = plans.slice(start, end);

    console.log(`\nLote ${start + 1}-${end}/${plans.length}`);

    const results = await Promise.allSettled(
      chunk.map((plan, offset) => processPlan(plan, start + offset))
    );

    let ok = 0;
    let fail = 0;

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        players.push(r.value);
        ok++;
      } else {
        fail++;
      }
    }

    console.log(`Batch done | ok=${ok} fail=${fail}`);
    savePlayersSnapshot(nextDrawId, drawState, players);
    console.log(`Snapshot salvo com ${players.length} players`);

    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  console.log("\n=== REQUEST RANDOMNESS ===");
  const randomness = loadOrCreateRandomnessKeypair();
  console.log("Randomness account:", randomness.publicKey.toBase58());

  const sigReq = await program.methods
    .requestRandomness()
    .accounts({
      draw: drawState,
      randomnessAccount: randomness.publicKey,
    })
    .rpc({ commitment: COMMITMENT });

  console.log("requestRandomness tx:", sigReq);

  await sleep(PAUSE_AFTER_REQUEST_RANDOMNESS_MS);

  console.log("\n=== CLOSE DRAW ===");
  const closeIxLimit = ComputeBudgetProgram.setComputeUnitLimit({
    units: 600_000,
  });

  const closeIxPrice = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 5_000,
  });

  const sigClose = await program.methods
    .closeDraw()
    .accounts({
      globalState: GLOBAL_STATE,
      draw: drawState,
      randomnessAccountData: randomness.publicKey,
    })
    .preInstructions([closeIxLimit, closeIxPrice])
    .rpc({ commitment: COMMITMENT });

  console.log("closeDraw tx:", sigClose);

  console.log("\n=== SETTLE TICKETS ===");
  for (let start = 0; start < players.length; start += SETTLE_BATCH_SIZE) {
    const end = Math.min(start + SETTLE_BATCH_SIZE, players.length);
    const chunk = players.slice(start, end);

    console.log(`Settle batch ${start + 1}-${end}/${players.length}`);

    const remaining = chunk.map((p) => ({
      pubkey: p.ticket,
      isWritable: true,
      isSigner: false,
    }));

    const sigSettle = await program.methods
      .settleTickets(new BN(chunk.length))
      .accounts({
        draw: drawState,
      })
      .remainingAccounts(remaining)
      .rpc({ commitment: COMMITMENT });

    console.log("settleTickets tx:", sigSettle);
    await sleep(PAUSE_BETWEEN_SETTLE_MS);
  }

  console.log("\n=== FINALIZE PAYOUTS ===");
  const sigFinalize = await program.methods
    .finalizePayouts()
    .accounts({
      globalState: GLOBAL_STATE,
      draw: drawState,
    })
    .rpc({ commitment: COMMITMENT });

  console.log("finalizePayouts tx:", sigFinalize);

  console.log("\n=== PAY WINNERS ===");
  let paid = 0;

  for (const p of players) {
    const ticketAcc: any = await program.account.ticket.fetch(p.ticket);
    const tier = toNumberSafe(ticketAcc.tier);
    const alreadyPaid = !!(ticketAcc.paid ?? false);

    if (tier <= 9 && !alreadyPaid) {
      try {
        const sigPay = await program.methods
          .payWinnersBatch(new BN(1))
          .accounts({
            globalState: GLOBAL_STATE,
            draw: drawState,
            ticket: p.ticket,
            prizeVault: PRIZE_VAULT,
            vaultAuthority: VAULT_AUTHORITY,
            userTokenAccount: p.ata,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc({ commitment: COMMITMENT });

        console.log(`payWinnersBatch tx (${p.player.publicKey.toBase58()}):`, sigPay);
        paid++;
        await sleep(250);
      } catch (err: any) {
        console.log(`FAIL pagamento ${p.player.publicKey.toBase58()}:`, err?.message || err);
      }
    }
  }

  const draw: any = await program.account.draw.fetch(drawState);

  const tiers = draw.winnerCounts ?? draw.winner_counts;
  const prizes = (draw.prizePerTier ?? draw.prize_per_tier).map((x: any) => toNumberSafe(x) / 1_000_000);

  console.log("\n=== FINAL STATUS ===");
  console.log("Draw:", drawState.toBase58());
  console.log("status:", toNumberSafe(draw.status));
  console.log("isOpen:", !!(draw.isOpen ?? draw.is_open));
  console.log("isClosed:", !!(draw.isClosed ?? draw.is_closed));
  console.log("randomnessRequested:", !!(draw.randomnessRequested ?? draw.randomness_requested));
  console.log("randomnessFulfilled:", !!(draw.randomnessFulfilled ?? draw.randomness_fulfilled));
  console.log("resultNumbers:", draw.resultNumbers ?? draw.result_numbers);
  console.log("resultCrypto:", draw.resultCrypto ?? draw.result_crypto);
  console.log("ticketsSold:", toNumberSafe(draw.ticketsSold ?? draw.tickets_sold));
  console.log("ticketsProcessed:", toNumberSafe(draw.ticketsProcessed ?? draw.tickets_processed));
  console.log("settlementComplete:", !!(draw.settlementComplete ?? draw.settlement_complete));
  console.log("isPaid:", !!(draw.isPaid ?? draw.is_paid));
  console.log("winnerCounts:", tiers.map((x: any) => toNumberSafe(x)));
  console.log("ticketsPaid:", toNumberSafe(draw.ticketsPaid ?? draw.tickets_paid));
  console.log("Pagamentos realizados no script:", paid);

  console.log("\n=== RELATÓRIO HUMANO ===");
  console.log(`4 números: ${toNumberSafe(tiers[5])} ganhador(es) → ${prizes[5]} USDT cada`);
  console.log(`3 números: ${toNumberSafe(tiers[7])} ganhador(es) → ${prizes[7]} USDT cada`);
  console.log(`2 números + crypto: ${toNumberSafe(tiers[8])} ganhador(es) → ${prizes[8]} USDT cada`);
  console.log(`2 números: ${toNumberSafe(tiers[9])} ganhador(es) → ${prizes[9]} USDT cada`);

  savePlayersSnapshot(nextDrawId, drawState, players);
  console.log("\n✅ STRESS FLOW 400 SNAPSHOT FINALIZADO");
}

main().catch((err) => {
  console.error("STRESS FLOW FAILED:");
  console.error(err);
  process.exit(1);
});

