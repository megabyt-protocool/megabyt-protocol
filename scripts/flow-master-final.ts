/**
 * MegaByt Protocol - flow-master-final.ts
 * 1 comando = fluxo completo
 *
 * Uso:
 *   TICKETS=20 npx ts-node --transpile-only scripts/flow-master-final.ts
 *   TICKETS=200 MODE=vrf npx ts-node --transpile-only scripts/flow-master-final.ts
 *
 * Env:
 *   TICKETS    - numero de tickets (default 20)
 *   BATCH      - settle batch size (default 20)
 *   MODE       - "test" (fulfill_randomness) ou "vrf" (switchboard real) (default test)
 *   DURATION   - duracao draw em segundos (default 600)
 *   MULTI      - tickets por user (default 1)
 */

const anchor = require("@coral-xyz/anchor");
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");

const IDL = require("../target/idl/megabyt.json");

const TICKETS = parseInt(process.env.TICKETS || "20", 10);
const BATCH = parseInt(process.env.BATCH || "20", 10);
const MODE = process.env.MODE || "test";
const DURATION = parseInt(process.env.DURATION || "600", 10);
const MULTI = parseInt(process.env.MULTI || "1", 10);

function log(s: string, m: string) {
  console.log("  [" + s + "] " + m);
}

function hr() {
  console.log("================================================================");
}

function step(n: number, t: string) {
  hr();
  console.log("  STEP " + n + ": " + t);
  hr();
}

async function confirmTx(conn: any, sig: string) {
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction(
    {
      signature: sig,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    },
    "confirmed"
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(o: any, a: string, b: string) {
  return o[a] !== undefined && o[a] !== null
    ? o[a]
    : o[b] !== undefined && o[b] !== null
    ? o[b]
    : null;
}

async function detectTP(conn: any, mint: any) {
  const info = await conn.getAccountInfo(mint);
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function ensureAta(conn: any, payer: any, mint: any, owner: any, tp: any) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tp);
  try {
    await getAccount(conn, ata, "confirmed", tp);
  } catch (_e) {
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      tp
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
  }
  return ata;
}

async function main() {
  const startTime = Date.now();

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new anchor.Program(IDL, provider);
  const wallet = provider.wallet.payer;
  const conn = provider.connection;

  console.log("");
  hr();
  console.log("  MEGABYT PROTOCOL — MASTER FLOW (FINAL)");
  console.log("  Tickets: " + TICKETS + " | Multi: " + MULTI + "/user | Mode: " + MODE);
  hr();
  console.log("");
  console.log("  Program:  " + program.programId.toBase58());
  console.log("  Wallet:   " + wallet.publicKey.toBase58());
  console.log("");

  // Bootstrap
  const gs = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")],
    program.programId
  )[0];

  const va = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority-v3")],
    program.programId
  )[0];

  const gd = await program.account.globalState.fetch(gs);
  const pv = pick(gd, "prizeVault", "prize_vault");
  const vi = await getAccount(conn, pv);
  const MINT = vi.mint;
  const TP = await detectTP(conn, MINT);
  const tp = Number(pick(gd, "ticketPrice", "ticket_price"));
  const did = Number(pick(gd, "currentDrawId", "current_draw_id") || 0);
  const adminBal = await conn.getBalance(wallet.publicKey);

  log("BOOT", "GlobalState:  " + gs.toBase58());
  log("BOOT", "Mint:         " + MINT.toBase58());
  log("BOOT", "TicketPrice:  " + tp);
  log("BOOT", "DrawID:       " + did);
  log("BOOT", "Admin SOL:    " + (adminBal / LAMPORTS_PER_SOL).toFixed(4));
  console.log("");

  // Step 1: Open draw
  step(1, "OPEN DRAW");

  const nid = new anchor.BN(did).add(new anchor.BN(1));
  const dp = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), nid.toArrayLike(Buffer, "le", 8)],
    program.programId
  )[0];

  await program.methods
    .openDraw(new anchor.BN(DURATION))
    .accounts({
      admin: wallet.publicKey,
      globalState: gs,
      drawState: dp,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const ga = await program.account.globalState.fetch(gs);
  const drawId = new anchor.BN(pick(ga, "currentDrawId", "current_draw_id"));
  const drawPda = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), drawId.toArrayLike(Buffer, "le", 8)],
    program.programId
  )[0];

  log("OK", "Draw #" + drawId.toString());
  console.log("");

  // Step 2: Fund + Buy
  step(2, "BUY " + TICKETS + " TICKETS (" + MULTI + " per user)");

  const adminAta = await ensureAta(conn, wallet, MINT, wallet.publicKey, TP);
  const usersNeeded = Math.ceil(TICKETS / MULTI);
  const users: any[] = [];

  for (let g = 0; g < usersNeeded; g++) {
    users.push(Keypair.generate());
  }

  // Fund SOL
  for (let s = 0; s < users.length; s += 10) {
    const batch = users.slice(s, Math.min(s + 10, users.length));
    const stx = new Transaction();

    for (let b = 0; b < batch.length; b++) {
      stx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: batch[b].publicKey,
          lamports: 0.015 * MULTI * LAMPORTS_PER_SOL,
        })
      );
    }

    await sendAndConfirmTransaction(conn, stx, [wallet]);

    if ((s + 10) % 50 === 0 || s + 10 >= users.length) {
      log("SOL", Math.min(s + 10, users.length) + "/" + users.length);
    }

    await sleep(100);
  }

  // Fund tokens + buy
  const allTicketPdas: any[] = [];
  let ticketsBought = 0;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    let currentUserBought = 0;

    try {
      const uAta = await ensureAta(conn, wallet, MINT, u.publicKey, TP);
      const tokenNeeded = tp * MULTI;
      const xIx = createTransferInstruction(adminAta, uAta, wallet.publicKey, tokenNeeded, [], TP);
      await sendAndConfirmTransaction(conn, new Transaction().add(xIx), [wallet]);

      for (let m = 0; m < MULTI; m++) {
        if (ticketsBought >= TICKETS) break;

        const uds = PublicKey.findProgramAddressSync(
          [Buffer.from("user-draw"), drawPda.toBuffer(), u.publicKey.toBuffer()],
          program.programId
        )[0];

        const currentIdx = m;
        const idxBuf = Buffer.alloc(4);
        idxBuf.writeUInt32LE(currentIdx, 0);

        const tPda = PublicKey.findProgramAddressSync(
          [Buffer.from("ticket"), drawPda.toBuffer(), u.publicKey.toBuffer(), idxBuf],
          program.programId
        )[0];

        allTicketPdas.push(tPda);

        const nums = new Set<number>();
        while (nums.size < 6) nums.add(Math.floor(Math.random() * 72) + 1);
        const cry = Math.floor(Math.random() * 10) + 1;

        try {
          await program.methods
            .buyTicket(Array.from(nums), cry)
            .accounts({
              user: u.publicKey,
              globalState: gs,
              drawState: drawPda,
              userDrawState: uds,
              ticket: tPda,
              userTokenAccount: uAta,
              prizeVault: pv,
              tokenProgram: TP,
              systemProgram: SystemProgram.programId,
            })
            .signers([u])
            .rpc();

          ticketsBought++;
          currentUserBought++;
        } catch (e: any) {
          console.error("");
          console.error("  [BUY-ERROR] user_index=" + i);
          console.error("  [BUY-ERROR] wallet=" + u.publicKey.toBase58());
          console.error("  [BUY-ERROR] multi_slot=" + m);
          console.error("  [BUY-ERROR] ticket_global=" + ticketsBought + "/" + TICKETS);
          console.error("  [BUY-ERROR] ticket_pda=" + tPda.toBase58());
          console.error("  [BUY-ERROR] user_draw_state=" + uds.toBase58());
          console.error("  [BUY-ERROR] user_ata=" + uAta.toBase58());
          console.error("  [BUY-ERROR] message=" + (e?.message || e));

          if (e?.logs) {
            console.error("  [BUY-ERROR-LOGS]");
            for (const l of e.logs) console.error("    " + l);
          }

          if (e?.stack) {
            console.error("  [BUY-ERROR-STACK]");
            console.error(String(e.stack));
          }

          throw e;
        }
      }

      if (ticketsBought % 10 === 0 || ticketsBought >= TICKETS) {
        log("BUY", ticketsBought + "/" + TICKETS);
      }

      await sleep(150);
    } catch (e: any) {
      console.error("");
      console.error("  [USER-ERROR] failed on user_index=" + i);
      console.error("  [USER-ERROR] wallet=" + u.publicKey.toBase58());
      console.error("  [USER-ERROR] bought_for_this_user=" + currentUserBought);
      console.error("  [USER-ERROR] total_bought=" + ticketsBought + "/" + TICKETS);
      console.error("  [USER-ERROR] message=" + (e?.message || e));

      if (e?.logs) {
        console.error("  [USER-ERROR-LOGS]");
        for (const l of e.logs) console.error("    " + l);
      }

      if (e?.stack) {
        console.error("  [USER-ERROR-STACK]");
        console.error(String(e.stack));
      }

      throw e;
    }
  }

  console.log("");

  // Step 3: Randomness
  step(3, "RANDOMNESS (" + MODE + ")");

  const rKp = Keypair.generate();

  await program.methods
    .requestRandomness()
    .accounts({
      draw: drawPda,
      randomnessAccount: rKp.publicKey,
    })
    .rpc();

  log("OK", "Requested");

  if (MODE === "test") {
    const seed: number[] = [];
    for (let ms = 0; ms < 32; ms++) seed.push(Math.floor(Math.random() * 256));

    await program.methods
      .fulfillRandomness(seed)
      .accounts({
        admin: wallet.publicKey,
        globalState: gs,
        draw: drawPda,
      })
      .rpc();

    log("OK", "Fulfilled (test seed)");
  } else {
    log("WAIT", "Waiting 15s for Switchboard VRF...");
    await sleep(15000);
  }

  console.log("");

  // Step 4: Close
  step(4, "CLOSE DRAW");

  const cIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });

  await program.methods
    .closeDraw()
    .accounts({
      globalState: gs,
      draw: drawPda,
      randomnessAccountData: rKp.publicKey,
    })
    .preInstructions([cIx])
    .rpc();

  const dc = await program.account.draw.fetch(drawPda);

  log("OK", "Closed");
  log("RESULT", "Numbers: " + String(pick(dc, "resultNumbers", "result_numbers")));
  log("RESULT", "Crypto:  " + String(pick(dc, "resultCrypto", "result_crypto")));
  console.log("");

  // Step 5: Settle
  step(5, "SETTLE " + allTicketPdas.length + " TICKETS");

  let off = 0;
  while (off < allTicketPdas.length) {
    const end = Math.min(off + BATCH, allTicketPdas.length);
    const rem = [];

    for (let j = off; j < end; j++) {
      rem.push({
        pubkey: allTicketPdas[j],
        isWritable: true,
        isSigner: false,
      });
    }

    await program.methods
      .settleTickets(rem.length)
      .accounts({
        draw: drawPda,
      })
      .remainingAccounts(rem)
      .rpc();

    off = end;

    if (off % 50 === 0 || off >= allTicketPdas.length) {
      log("SETTLE", off + "/" + allTicketPdas.length);
    }

    await sleep(200);
  }

  const ds = await program.account.draw.fetch(drawPda);
  const wc = pick(ds, "winnerCounts", "winner_counts") || [];
  let tw = 0;
  for (let w = 0; w < wc.length; w++) tw += Number(wc[w]);

  log("WINNERS", tw + " total | " + String(wc));
  console.log("");

  // Step 6: Finalize
  step(6, "FINALIZE PAYOUTS");

  await program.methods
    .finalizePayouts()
    .accounts({
      globalState: gs,
      draw: drawPda,
    })
    .rpc();

  const df = await program.account.draw.fetch(drawPda);

  log("OK", "Finalized");
  log("PRIZES", String(pick(df, "prizePerTier", "prize_per_tier")));
  log(
    "MONTHLY",
    "Rollover: " +
      String(pick(df, "monthlyRolloverContribution", "monthly_rollover_contribution") || 0)
  );
  console.log("");

  // Step 7: Pay
  step(7, "PAY WINNERS");

  const winners = [];
  for (let k = 0; k < allTicketPdas.length; k++) {
    try {
      const t = await program.account.ticket.fetch(allTicketPdas[k]);
      if (t.tier <= 9 && !t.paid) {
        winners.push({ publicKey: allTicketPdas[k], account: t });
      }
    } catch (_e) {
      continue;
    }
  }

  log("INFO", "Winners: " + winners.length);

  let paid = 0;
  for (let p = 0; p < winners.length; p++) {
    const wt: any = winners[p];
    const wo = wt.account.owner;
    if (!wo) continue;

    const wa = getAssociatedTokenAddressSync(MINT, wo, false, TP);

    try {
      await program.methods
        .payWinnersBatch(1)
        .accounts({
          draw: drawPda,
          ticket: wt.publicKey,
          globalState: gs,
          prizeVault: pv,
          userTokenAccount: wa,
          vaultAuthority: va,
          tokenProgram: TP,
        })
        .rpc();

      paid++;
    } catch (_e) {}

    await sleep(200);
  }

  if (winners.length === 0 && allTicketPdas.length > 0) {
    const fo = users[0].publicKey;
    const fa = getAssociatedTokenAddressSync(MINT, fo, false, TP);

    try {
      await program.methods
        .payWinnersBatch(1)
        .accounts({
          draw: drawPda,
          ticket: allTicketPdas[0],
          globalState: gs,
          prizeVault: pv,
          userTokenAccount: fa,
          vaultAuthority: va,
          tokenProgram: TP,
        })
        .rpc();
    } catch (_e) {}

    log("OK", "Fast-path (zero winners)");
  }

  log("OK", "Paid " + paid + " winner(s)");
  console.log("");

  // Final
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const endBal = await conn.getBalance(wallet.publicKey);
  const dFinal = await program.account.draw.fetch(drawPda);
  const gFinal = await program.account.globalState.fetch(gs);

  hr();
  console.log("  DRAW #" + drawId.toString() + " — FINAL REPORT");
  hr();
  console.log("");

  console.log("  draw_id:              " + String(dFinal.id));
  console.log("  status:               " + String(dFinal.status));
  console.log("  result_numbers:       " + String(pick(dFinal, "resultNumbers", "result_numbers")));
  console.log("  result_crypto:        " + String(pick(dFinal, "resultCrypto", "result_crypto")));
  console.log("  tickets_sold:         " + String(pick(dFinal, "ticketsSold", "tickets_sold")));
  console.log("  tickets_processed:    " + String(pick(dFinal, "ticketsProcessed", "tickets_processed")));
  console.log("  winner_counts:        " + String(pick(dFinal, "winnerCounts", "winner_counts")));
  console.log("  prize_per_tier:       " + String(pick(dFinal, "prizePerTier", "prize_per_tier")));
  console.log("  tickets_paid:         " + String(pick(dFinal, "ticketsPaid", "tickets_paid")));
  console.log("  is_paid:              " + String(pick(dFinal, "isPaid", "is_paid")));
  console.log(
    "  monthly_rollover:     " +
      String(pick(dFinal, "monthlyRolloverContribution", "monthly_rollover_contribution") || 0)
  );
  console.log("");

  console.log("  === ECONOMICS ===");
  console.log("  monthly_pool:         " + String(pick(gFinal, "monthlyPool", "monthly_pool")));
  console.log("  referral_total:       " + String(pick(gFinal, "referralTotal", "referral_total")));
  console.log("  daily_total:          " + String(pick(gFinal, "dailyTotal", "daily_total")));
  console.log("");

  console.log("  === COST ===");
  console.log("  SOL spent:            " + ((adminBal - endBal) / LAMPORTS_PER_SOL).toFixed(4));
  console.log("  Time:                 " + elapsed + "s");
  console.log("  Avg/ticket:           " + (parseFloat(elapsed) / TICKETS).toFixed(2) + "s");
  console.log("");

  console.log(
    "  Explorer: https://explorer.solana.com/address/" +
      drawPda.toBase58() +
      "?cluster=devnet"
  );
  console.log("");

  hr();
  console.log("  MegaByt. Provably fair. Fully on-chain.");
  hr();
  console.log("");
}

main().catch(function (e: any) {
  console.error("");
  console.error("ERROR: " + (e?.message || e));

  if (e?.name) console.error("ERROR_NAME: " + e.name);
  if (e?.code) console.error("ERROR_CODE: " + e.code);
  if (e?.stack) {
    console.error("ERROR_STACK:");
    console.error(String(e.stack));
  }

  if (e?.logs) {
    console.error("ERROR_LOGS:");
    e.logs.forEach(function (l: string) {
      console.error("  " + l);
    });
  }

  process.exit(1);
});

