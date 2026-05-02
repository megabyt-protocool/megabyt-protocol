import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const idl = require("../target/idl/megabyt.json");

// =========================
// CONFIG
// =========================
const DRAW_ID = 43;
const DRAW_PUBKEY = new PublicKey("HT2yrWfp1BBsWRWVDJkJHeqvnL9NBjHfeTAhhxqsQ5Jt");
const GLOBAL_STATE = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");
const PRIZE_VAULT = new PublicKey("8sEKCpLjLLZzRjwKXfn5ubYhuJu2jdYFa5ngqbTyw7mz");
const VAULT_AUTHORITY = new PublicKey("5Xb9XSLMwCpDVmiC91H7k7gTeGbfSgm9DjRkVaBnmxxF");
const TOKEN_MINT = new PublicKey("HkahNWz3FB53wYNKgZaEYrrC3K9DbQoWuydKM2HPqiUd");

const SETTLE_BATCH = 20;
const PAY_DELAY_MS = 200;
const SETTLE_DELAY_MS = 250;
const CLOSE_WAIT_MS = 1500;

// Ticket layout offsets
const TICKET_DRAW_OFFSET = 8 + 32; // discriminator + owner = 40

// =========================
// HELPERS
// =========================
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pick(obj: any, ...keys: string[]) {
  for (const k of keys) {
    if (obj && typeof obj[k] !== "undefined" && obj[k] !== null) return obj[k];
  }
  return undefined;
}

async function detectTokenProgram(connection: any, mint: PublicKey) {
  const info = await connection.getAccountInfo(mint);
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function ensureAta(
  connection: any,
  provider: any,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey
) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId);

  const info = await connection.getAccountInfo(ata);
  if (info) return ata;

  const ix = createAssociatedTokenAccountInstruction(
    provider.wallet.publicKey,
    ata,
    owner,
    mint,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new anchor.web3.Transaction().add(ix);
  await provider.sendAndConfirm(tx, []);
  return ata;
}

function randomSeed32(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) out.push(Math.floor(Math.random() * 256));
  return out;
}

async function fetchDrawTickets(program: Program<any>) {
  return await program.account.ticket.all([
    {
      memcmp: {
        offset: TICKET_DRAW_OFFSET,
        bytes: DRAW_PUBKEY.toBase58(),
      },
    },
  ]);
}

// =========================
// MAIN
// =========================
(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program(idl as any, provider) as Program<any>;
  const connection = provider.connection;
  const wallet = provider.wallet as any;

  const tokenProgramId = await detectTokenProgram(connection, TOKEN_MINT);

  console.log("");
  console.log("================================================================");
  console.log("  MEGABYT — CONTINUE DRAW #" + DRAW_ID);
  console.log("================================================================");
  console.log("");
  console.log("  Program:      " + program.programId.toBase58());
  console.log("  Admin:        " + wallet.publicKey.toBase58());
  console.log("  Draw PDA:     " + DRAW_PUBKEY.toBase58());
  console.log("  GlobalState:  " + GLOBAL_STATE.toBase58());
  console.log("");

  // =========================
  // CHECK DRAW STATE
  // =========================
  const drawBefore = await program.account.draw.fetch(DRAW_PUBKEY);

  const isClosedBefore = !!pick(drawBefore, "isClosed", "is_closed");
  const randomnessRequestedBefore = !!pick(drawBefore, "randomnessRequested", "randomness_requested");
  const randomnessFulfilledBefore = !!pick(drawBefore, "randomnessFulfilled", "randomness_fulfilled");
  const ticketsSoldBefore = Number(pick(drawBefore, "ticketsSold", "tickets_sold") || 0);

  console.log("  === CURRENT DRAW STATE ===");
  console.log("  is_closed:            " + isClosedBefore);
  console.log("  randomness_requested: " + randomnessRequestedBefore);
  console.log("  randomness_fulfilled: " + randomnessFulfilledBefore);
  console.log("  tickets_sold:         " + ticketsSoldBefore);
  console.log("");

  if (ticketsSoldBefore <= 0) {
    throw new Error("Draw has no tickets sold. Nothing to continue.");
  }

  // =========================
  // FIND ALL TICKETS FOR THIS DRAW
  // =========================
  console.log("FINDING TICKETS FOR DRAW #" + DRAW_ID + " ...");

  const drawTickets = await fetchDrawTickets(program);

  console.log("  Tickets found: " + drawTickets.length);
  console.log("");

  if (drawTickets.length === 0) {
    throw new Error("No ticket accounts found for this draw.");
  }

  // =========================
  // REQUEST RANDOMNESS
  // =========================
  const randomnessKp = Keypair.generate();

  if (!randomnessRequestedBefore) {
    console.log("REQUEST RANDOMNESS...");

    await program.methods
      .requestRandomness()
      .accounts({
        draw: DRAW_PUBKEY,
        randomnessAccount: randomnessKp.publicKey,
      })
      .rpc();

    console.log("  OK request_randomness");
    await sleep(1000);
  } else {
    console.log("SKIP REQUEST RANDOMNESS (already requested on-chain)");
  }

  // =========================
  // FULFILL RANDOMNESS (TEST MODE)
  // =========================
  const drawAfterRequest = await program.account.draw.fetch(DRAW_PUBKEY);
  const randomnessFulfilledNow = !!pick(drawAfterRequest, "randomnessFulfilled", "randomness_fulfilled");

  if (!randomnessFulfilledNow) {
    console.log("FULFILL RANDOMNESS (TEST MODE)...");

    const seed = randomSeed32();

    await program.methods
      .fulfillRandomness(seed)
      .accounts({
        admin: wallet.publicKey,
        globalState: GLOBAL_STATE,
        draw: DRAW_PUBKEY,
      })
      .rpc();

    console.log("  OK fulfill_randomness");
    await sleep(1000);
  } else {
    console.log("SKIP FULFILL RANDOMNESS (already fulfilled on-chain)");
  }

  // =========================
  // CLOSE DRAW
  // =========================
  const drawAfterFulfill = await program.account.draw.fetch(DRAW_PUBKEY);
  const isClosedMid = !!pick(drawAfterFulfill, "isClosed", "is_closed");

  if (!isClosedMid) {
    console.log("CLOSE DRAW...");

    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });

    await program.methods
      .closeDraw()
      .accounts({
        globalState: GLOBAL_STATE,
        draw: DRAW_PUBKEY,
        randomnessAccountData: randomnessKp.publicKey,
      })
      .preInstructions([cuIx])
      .rpc();

    console.log("  OK close_draw");
    await sleep(CLOSE_WAIT_MS);
  } else {
    console.log("SKIP CLOSE DRAW (already closed on-chain)");
  }

  const drawAfterClose = await program.account.draw.fetch(DRAW_PUBKEY);

  console.log("");
  console.log("  === POST-CLOSE STATE ===");
  console.log("  status:         " + String(drawAfterClose.status));
  console.log("  is_closed:      " + String(pick(drawAfterClose, "isClosed", "is_closed")));
  console.log("  result_numbers: " + String(pick(drawAfterClose, "resultNumbers", "result_numbers")));
  console.log("  result_crypto:  " + String(pick(drawAfterClose, "resultCrypto", "result_crypto")));
  console.log("");

  // =========================
  // SETTLE
  // =========================
  console.log("SETTLE...");

  let offset = 0;
  while (offset < drawTickets.length) {
    const end = Math.min(offset + SETTLE_BATCH, drawTickets.length);

    const remainingAccounts = drawTickets.slice(offset, end).map((t: any) => ({
      pubkey: t.publicKey,
      isWritable: true,
      isSigner: false,
    }));

    await program.methods
      .settleTickets(new BN(remainingAccounts.length))
      .accounts({
        draw: DRAW_PUBKEY,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    offset = end;
    console.log("  settled: " + offset + "/" + drawTickets.length);
    await sleep(SETTLE_DELAY_MS);
  }

  const drawAfterSettle = await program.account.draw.fetch(DRAW_PUBKEY);

  console.log("");
  console.log("  === POST-SETTLE STATE ===");
  console.log("  tickets_processed:    " + String(pick(drawAfterSettle, "ticketsProcessed", "tickets_processed")));
  console.log("  settlement_complete:  " + String(pick(drawAfterSettle, "settlementComplete", "settlement_complete")));
  console.log("  winner_counts:        " + String(pick(drawAfterSettle, "winnerCounts", "winner_counts")));
  console.log("");

  // =========================
  // FINALIZE
  // =========================
  console.log("FINALIZE...");

  await program.methods
    .finalizePayouts()
    .accounts({
      globalState: GLOBAL_STATE,
      draw: DRAW_PUBKEY,
    })
    .rpc();

  const drawAfterFinalize = await program.account.draw.fetch(DRAW_PUBKEY);

  console.log("  OK finalize_payouts");
  console.log("  prize_per_tier: " + String(pick(drawAfterFinalize, "prizePerTier", "prize_per_tier")));
  console.log(
    "  monthly_rollover: " +
      String(pick(drawAfterFinalize, "monthlyRolloverContribution", "monthly_rollover_contribution") || 0)
  );
  console.log("");

  // =========================
  // PAYOUT
  // =========================
  console.log("PAYOUT...");

  const winners = [];
  for (const t of drawTickets) {
    try {
      const acc = await program.account.ticket.fetch(t.publicKey);
      const tier = Number(acc.tier);
      const paid = !!acc.paid;

      if (tier <= 9 && !paid) {
        winners.push({
          publicKey: t.publicKey,
          account: acc,
        });
      }
    } catch {
      continue;
    }
  }

  console.log("  Winners pending payment: " + winners.length);

  let paid = 0;

  for (const wt of winners) {
    const owner = new PublicKey(wt.account.owner || wt.account.user);
    const ata = await ensureAta(connection, provider, owner, TOKEN_MINT, tokenProgramId);

    try {
      await program.methods
        .payWinnersBatch(new BN(1))
        .accounts({
          draw: DRAW_PUBKEY,
          ticket: wt.publicKey,
          globalState: GLOBAL_STATE,
          prizeVault: PRIZE_VAULT,
          userTokenAccount: ata,
          vaultAuthority: VAULT_AUTHORITY,
          tokenProgram: tokenProgramId,
        })
        .rpc();

      paid++;
      console.log("  paid: " + wt.publicKey.toBase58());
    } catch (e: any) {
      console.log("  pay failed: " + wt.publicKey.toBase58() + " | " + (e?.message || e));
    }

    await sleep(PAY_DELAY_MS);
  }

  if (winners.length === 0 && drawTickets.length > 0) {
    const fallbackTicket = drawTickets[0].publicKey;
    const fallbackOwner = new PublicKey(drawTickets[0].account.owner || drawTickets[0].account.user);
    const fallbackAta = await ensureAta(connection, provider, fallbackOwner, TOKEN_MINT, tokenProgramId);

    try {
      await program.methods
        .payWinnersBatch(new BN(1))
        .accounts({
          draw: DRAW_PUBKEY,
          ticket: fallbackTicket,
          globalState: GLOBAL_STATE,
          prizeVault: PRIZE_VAULT,
          userTokenAccount: fallbackAta,
          vaultAuthority: VAULT_AUTHORITY,
          tokenProgram: tokenProgramId,
        })
        .rpc();

      console.log("  OK fast-path zero winners");
    } catch (e: any) {
      console.log("  fast-path skipped: " + (e?.message || e));
    }
  }

  // =========================
  // FINAL REPORT
  // =========================
  const drawFinal = await program.account.draw.fetch(DRAW_PUBKEY);

  console.log("");
  console.log("================================================================");
  console.log("  DRAW #" + DRAW_ID + " — FINAL REPORT");
  console.log("================================================================");
  console.log("");
  console.log("  draw_pda:             " + DRAW_PUBKEY.toBase58());
  console.log("  status:               " + String(drawFinal.status));
  console.log("  is_closed:            " + String(pick(drawFinal, "isClosed", "is_closed")));
  console.log("  tickets_sold:         " + String(pick(drawFinal, "ticketsSold", "tickets_sold")));
  console.log("  tickets_processed:    " + String(pick(drawFinal, "ticketsProcessed", "tickets_processed")));
  console.log("  winner_counts:        " + String(pick(drawFinal, "winnerCounts", "winner_counts")));
  console.log("  prize_per_tier:       " + String(pick(drawFinal, "prizePerTier", "prize_per_tier")));
  console.log("  tickets_paid:         " + String(pick(drawFinal, "ticketsPaid", "tickets_paid")));
  console.log("  is_paid:              " + String(pick(drawFinal, "isPaid", "is_paid")));
  console.log("  result_numbers:       " + String(pick(drawFinal, "resultNumbers", "result_numbers")));
  console.log("  result_crypto:        " + String(pick(drawFinal, "resultCrypto", "result_crypto")));
  console.log("  randomness_requested: " + String(pick(drawFinal, "randomnessRequested", "randomness_requested")));
  console.log("  randomness_fulfilled: " + String(pick(drawFinal, "randomnessFulfilled", "randomness_fulfilled")));
  console.log("");
  console.log("  Paid winners in this run: " + paid);
  console.log("");
  console.log(
    "  Explorer: https://explorer.solana.com/address/" +
      DRAW_PUBKEY.toBase58() +
      "?cluster=devnet"
  );
  console.log("");
  console.log("================================================================");
  console.log("  MegaByt. Provably fair. Fully on-chain.");
  console.log("================================================================");
  console.log("");
})().catch((e: any) => {
  console.error("");
  console.error("ERROR: " + (e?.message || e));

  if (e?.logs) {
    console.error("ERROR_LOGS:");
    for (const l of e.logs) {
      console.error("  " + l);
    }
  }

  if (e?.stack) {
    console.error("ERROR_STACK:");
    console.error(String(e.stack));
  }

  process.exit(1);
});

