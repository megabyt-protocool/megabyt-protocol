/**
 * MegaByt Protocol — flow-1000-devnet.ts
 * Robust 1000-ticket stress test with checkpoint/resume
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/flow-1000-devnet.ts
 *
 * Resume after interruption:
 *   npx ts-node --transpile-only scripts/flow-1000-devnet.ts
 *   (auto-detects checkpoint and continues from where it stopped)
 *
 * Env (optional):
 *   TICKETS    - target ticket count (default 1000)
 *   MULTI      - tickets per user (default 5)
 *   BATCH      - settle batch size (default 20)
 *   DURATION   - draw duration in seconds (default 3600)
 *   MODE       - "test" or "vrf" (default test)
 *   PHASE      - start at specific phase: "buy", "settle", "finalize", "pay"
 *   CLEAN      - set to "1" to delete checkpoint and start fresh
 */

var anchor = require("@coral-xyz/anchor");
var { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } = require("@solana/web3.js");
var { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
var fs = require("fs");
var path = require("path");
var IDL = require("../target/idl/megabyt.json");

// ===== CONFIG =====
var TICKETS = parseInt(process.env.TICKETS || "1000", 10);
var MULTI = parseInt(process.env.MULTI || "5", 10);
var BATCH_SETTLE = parseInt(process.env.BATCH || "20", 10);
var DURATION = parseInt(process.env.DURATION || "3600", 10);
var MODE = process.env.MODE || "test";
var FORCE_PHASE = process.env.PHASE || "";
var CLEAN = process.env.CLEAN === "1";

var USERS_NEEDED = Math.ceil(TICKETS / MULTI);
var WALLET_BATCH_SIZE = 10;    // wallets per funding batch
var SOL_PER_WALLET = 0.015 * MULTI;  // SOL to fund each wallet
var RETRY_MAX = 3;
var RETRY_BASE_MS = 2000;     // 2s, 4s, 8s exponential backoff
var DELAY_BETWEEN_BUYS_MS = 150;
var DELAY_BETWEEN_SETTLE_MS = 200;
var DELAY_BETWEEN_PAY_MS = 200;
var MIN_SOL_RESERVE = 0.5;    // abort if admin drops below this

var CHECKPOINT_DIR = path.join(__dirname, "..", "artifacts_batches");
var CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, "flow-1000-checkpoint.json");

// ===== TYPES =====
interface CheckpointData {
  version: number;
  tickets: number;
  multi: number;
  drawId: number;
  drawPda: string;
  phase: string;  // "buy" | "settle" | "finalize" | "pay" | "done"
  usersCompleted: number;  // wallets fully processed (funded + bought)
  ticketsBought: number;
  wallets: Array<{ secret: number[], publicKey: string }>;
  ticketPdas: string[];
  startedAt: string;
  lastUpdatedAt: string;
  solSpentEstimate: number;
  errors: string[];
}

// ===== HELPERS =====
function log(s: string, m: string) { console.log("  [" + s + "] " + m); }
function logErr(s: string, m: string) { console.error("  [" + s + "] " + m); }
function hr() { console.log("================================================================"); }
function step(n: number, t: string) { hr(); console.log("  STEP " + n + ": " + t); hr(); }
function sleep(ms: number) { return new Promise(function(r: any) { setTimeout(r, ms); }); }
function now() { return new Date().toISOString(); }

function pick(o: any, a: string, b: string) {
  return o[a] !== undefined && o[a] !== null ? o[a] : (o[b] !== undefined && o[b] !== null ? o[b] : null);
}

async function detectTP(conn: any, mint: any) {
  var info = await conn.getAccountInfo(mint);
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function ensureAta(conn: any, payer: any, mint: any, owner: any, tp: any) {
  var ata = getAssociatedTokenAddressSync(mint, owner, false, tp);
  try {
    await getAccount(conn, ata, "confirmed", tp);
  } catch (e) {
    var ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, tp);
    await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
  }
  return ata;
}

async function retryAsync(fn: () => Promise<any>, label: string, errors: string[]): Promise<any> {
  for (var attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      var msg = e.message || String(e);

      // Don't retry on program errors (logic errors, not transient)
      if (msg.indexOf("custom program error") !== -1 && msg.indexOf("0x1") !== -1) {
        throw e;  // insufficient funds — not transient
      }
      if (msg.indexOf("AlreadyInUse") !== -1 || msg.indexOf("already in use") !== -1) {
        throw e;  // account exists — skip, not retry
      }

      if (attempt < RETRY_MAX) {
        var delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        log("RETRY", label + " attempt " + attempt + "/" + RETRY_MAX + " failed: " + msg.slice(0, 80));
        log("RETRY", "Waiting " + (delayMs / 1000) + "s before retry...");
        await sleep(delayMs);
      } else {
        errors.push(label + ": " + msg.slice(0, 120));
        throw e;
      }
    }
  }
}

async function checkSolBalance(conn: any, wallet: any, minSol: number, context: string): Promise<number> {
  var bal = await conn.getBalance(wallet.publicKey);
  var sol = bal / LAMPORTS_PER_SOL;
  if (sol < minSol) {
    logErr("ABORT", context + " — SOL too low: " + sol.toFixed(4) + " < " + minSol + " SOL");
    logErr("ABORT", "Top up and re-run. Checkpoint is saved.");
    return -1;
  }
  return bal;
}

// ===== CHECKPOINT =====
function saveCheckpoint(cp: CheckpointData) {
  if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  cp.lastUpdatedAt = now();
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

function loadCheckpoint(): CheckpointData | null {
  if (!fs.existsSync(CHECKPOINT_FILE)) return null;
  try {
    var raw = fs.readFileSync(CHECKPOINT_FILE, "utf-8");
    var cp = JSON.parse(raw) as CheckpointData;
    if (cp.version !== 1) return null;
    if (cp.tickets !== TICKETS || cp.multi !== MULTI) {
      log("WARN", "Checkpoint has different config (tickets=" + cp.tickets + " multi=" + cp.multi + "). Ignoring.");
      return null;
    }
    return cp;
  } catch (e) {
    return null;
  }
}

function deleteCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    log("CLEAN", "Deleted old checkpoint");
  }
}

// ===== MAIN =====
async function main() {
  var globalStartTime = Date.now();
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = new anchor.Program(IDL, provider);
  var wallet = (provider.wallet as any).payer;
  var conn = provider.connection;

  console.log("");
  hr();
  console.log("  MEGABYT PROTOCOL — 1000-TICKET STRESS TEST");
  console.log("  Tickets: " + TICKETS + " | Wallets: " + USERS_NEEDED + " x " + MULTI + "/user | Mode: " + MODE);
  hr();
  console.log("");
  console.log("  Program:  " + program.programId.toBase58());
  console.log("  Wallet:   " + wallet.publicKey.toBase58());
  console.log("");

  // Clean if requested
  if (CLEAN) deleteCheckpoint();

  // ===== BOOTSTRAP ON-CHAIN STATE =====
  var gs = PublicKey.findProgramAddressSync([Buffer.from("global-state-v3")], program.programId)[0];
  var va = PublicKey.findProgramAddressSync([Buffer.from("vault-authority-v3")], program.programId)[0];
  var gd = await program.account.globalState.fetch(gs);
  var pv = pick(gd, "prizeVault", "prize_vault");
  var vi = await getAccount(conn, pv);
  var MINT = vi.mint;
  var TP = await detectTP(conn, MINT);
  var ticketPrice = Number(pick(gd, "ticketPrice", "ticket_price"));
  var currentDrawId = Number(pick(gd, "currentDrawId", "current_draw_id") || 0);

  var adminBal = await conn.getBalance(wallet.publicKey);
  var adminAta = await ensureAta(conn, wallet, MINT, wallet.publicKey, TP);
  var adminToken = Number((await getAccount(conn, adminAta, "confirmed", TP)).amount);

  log("BOOT", "GlobalState:  " + gs.toBase58());
  log("BOOT", "Mint:         " + MINT.toBase58());
  log("BOOT", "TicketPrice:  " + ticketPrice);
  log("BOOT", "DrawID:       " + currentDrawId);
  log("BOOT", "Admin SOL:    " + (adminBal / LAMPORTS_PER_SOL).toFixed(4));
  log("BOOT", "Admin Token:  " + adminToken);
  console.log("");

  // ===== PRE-FLIGHT CHECK =====
  var solNeeded = (USERS_NEEDED * SOL_PER_WALLET) + 2;  // 2 SOL margin for ops
  var tokenNeeded = TICKETS * ticketPrice;

  if (adminBal / LAMPORTS_PER_SOL < 12) {
    logErr("ABORT", "SOL balance too low: " + (adminBal / LAMPORTS_PER_SOL).toFixed(4) + " < 12 SOL minimum");
    logErr("ABORT", "Run: solana airdrop 2 --url devnet (repeat as needed)");
    process.exit(1);
  }
  if (adminToken < tokenNeeded) {
    logErr("ABORT", "Token balance too low: " + adminToken + " < " + tokenNeeded);
    logErr("ABORT", "Run: spl-token mint " + MINT.toBase58() + " " + (tokenNeeded - adminToken));
    process.exit(1);
  }
  log("PREFLIGHT", "SOL check passed:   " + (adminBal / LAMPORTS_PER_SOL).toFixed(4) + " SOL");
  log("PREFLIGHT", "Token check passed: " + adminToken + " >= " + tokenNeeded);
  console.log("");

  // ===== LOAD OR CREATE CHECKPOINT =====
  var cp = loadCheckpoint();
  var isResume = false;

  if (cp) {
    isResume = true;
    log("RESUME", "Found checkpoint from " + cp.lastUpdatedAt);
    log("RESUME", "Draw #" + cp.drawId + " | Phase: " + cp.phase);
    log("RESUME", "Users completed: " + cp.usersCompleted + "/" + USERS_NEEDED);
    log("RESUME", "Tickets bought: " + cp.ticketsBought + "/" + TICKETS);
    console.log("");
  }

  // ===== PHASE: OPEN DRAW =====
  var drawId: any;
  var drawPda: any;
  var allWallets: any[] = [];
  var allTicketPdas: any[] = [];

  if (cp && cp.drawId > 0) {
    // Resume: use existing draw
    drawId = new anchor.BN(cp.drawId);
    drawPda = new PublicKey(cp.drawPda);

    // Reconstruct wallets from checkpoint
    for (var wi = 0; wi < cp.wallets.length; wi++) {
      allWallets.push(Keypair.fromSecretKey(new Uint8Array(cp.wallets[wi].secret)));
    }

    // Reconstruct ticket PDAs from checkpoint
    for (var ti = 0; ti < cp.ticketPdas.length; ti++) {
      allTicketPdas.push(new PublicKey(cp.ticketPdas[ti]));
    }

    log("RESUME", "Restored " + allWallets.length + " wallets, " + allTicketPdas.length + " ticket PDAs");
    console.log("");
  } else {
    // Fresh start: open new draw
    step(1, "OPEN DRAW");
    var nid = new anchor.BN(currentDrawId).add(new anchor.BN(1));
    var dpPre = PublicKey.findProgramAddressSync(
      [Buffer.from("draw-v3"), nid.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

    await retryAsync(async function() {
      await (program.methods.openDraw(new anchor.BN(DURATION)).accounts)({
        admin: wallet.publicKey, globalState: gs, drawState: dpPre,
        systemProgram: SystemProgram.programId
      }).rpc();
    }, "open_draw", []);

    var gaAfter = await program.account.globalState.fetch(gs);
    drawId = new anchor.BN(pick(gaAfter, "currentDrawId", "current_draw_id"));
    drawPda = PublicKey.findProgramAddressSync(
      [Buffer.from("draw-v3"), drawId.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

    log("OK", "Draw #" + drawId.toString() + " opened");
    log("PDA", drawPda.toBase58());
    console.log("");

    // Generate all wallets upfront
    for (var gi = 0; gi < USERS_NEEDED; gi++) {
      allWallets.push(Keypair.generate());
    }

    // Create initial checkpoint
    cp = {
      version: 1,
      tickets: TICKETS,
      multi: MULTI,
      drawId: Number(drawId.toString()),
      drawPda: drawPda.toBase58(),
      phase: "buy",
      usersCompleted: 0,
      ticketsBought: 0,
      wallets: allWallets.map(function(w: any) {
        return { secret: Array.from(w.secretKey), publicKey: w.publicKey.toBase58() };
      }),
      ticketPdas: [],
      startedAt: now(),
      lastUpdatedAt: now(),
      solSpentEstimate: 0,
      errors: []
    };
    saveCheckpoint(cp);
    log("CHECKPOINT", "Initial checkpoint saved (" + allWallets.length + " wallets)");
    console.log("");
  }

  // Determine starting phase
  var startPhase = cp.phase;
  if (FORCE_PHASE) startPhase = FORCE_PHASE;

  // ================================================================
  // PHASE: BUY TICKETS
  // ================================================================
  if (startPhase === "buy") {
    step(2, "BUY " + TICKETS + " TICKETS (" + USERS_NEEDED + " wallets x " + MULTI + ")");

    var usersStart = cp.usersCompleted;
    var ticketsStart = cp.ticketsBought;

    if (usersStart > 0) {
      log("RESUME", "Skipping " + usersStart + " already-completed wallets (" + ticketsStart + " tickets)");
    }

    var batchStartTime = Date.now();
    var batchErrors: string[] = [];

    for (var ui = usersStart; ui < USERS_NEEDED; ui++) {
      var u = allWallets[ui];

      // === SOL balance gate every 50 wallets ===
      if (ui % 50 === 0 && ui > usersStart) {
        var midBal = await checkSolBalance(conn, wallet, MIN_SOL_RESERVE, "Mid-run SOL check at wallet " + ui);
        if (midBal === -1) {
          saveCheckpoint(cp);
          process.exit(1);
        }
        var elapsed50 = ((Date.now() - batchStartTime) / 1000).toFixed(0);
        var rate = ((ui - usersStart) > 0) ? ((Date.now() - batchStartTime) / (ui - usersStart) / 1000).toFixed(2) : "?";
        var remaining = USERS_NEEDED - ui;
        var etaMin = ((remaining * parseFloat(rate)) / 60).toFixed(1);
        log("PROGRESS", "Wallet " + ui + "/" + USERS_NEEDED + " | " + cp.ticketsBought + " tickets | " + elapsed50 + "s elapsed | ~" + etaMin + "min remaining");
        log("SOL", (midBal / LAMPORTS_PER_SOL).toFixed(4) + " SOL remaining");
      }

      // === Fund SOL to user wallet ===
      try {
        await retryAsync(async function() {
          var stx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: u.publicKey,
              lamports: Math.floor(SOL_PER_WALLET * LAMPORTS_PER_SOL)
            })
          );
          await sendAndConfirmTransaction(conn, stx, [wallet]);
        }, "fund-sol-wallet-" + ui, batchErrors);
      } catch (e: any) {
        logErr("SKIP", "Wallet " + ui + " SOL funding failed permanently: " + (e.message || "").slice(0, 80));
        continue;  // skip this wallet entirely
      }

      // === Create ATA + fund tokens ===
      var uAta: any;
      try {
        uAta = await retryAsync(async function() {
          return await ensureAta(conn, wallet, MINT, u.publicKey, TP);
        }, "ata-wallet-" + ui, batchErrors);

        var tokenAmount = ticketPrice * MULTI;
        await retryAsync(async function() {
          var xIx = createTransferInstruction(adminAta, uAta, wallet.publicKey, tokenAmount, [], TP);
          await sendAndConfirmTransaction(conn, new Transaction().add(xIx), [wallet]);
        }, "fund-token-wallet-" + ui, batchErrors);
      } catch (e: any) {
        logErr("SKIP", "Wallet " + ui + " token funding failed permanently: " + (e.message || "").slice(0, 80));
        continue;
      }

      // === Buy MULTI tickets ===
      var ticketsThisUser = 0;

      for (var mi = 0; mi < MULTI; mi++) {
        if (cp.ticketsBought >= TICKETS) break;

        // Derive UserDrawState PDA
        var uds = PublicKey.findProgramAddressSync(
          [Buffer.from("user-draw"), drawPda.toBuffer(), u.publicKey.toBuffer()],
          program.programId
        )[0];

        // Derive Ticket PDA with index
        var idxBuf = Buffer.alloc(4);
        idxBuf.writeUInt32LE(mi, 0);
        var tPda = PublicKey.findProgramAddressSync(
          [Buffer.from("ticket"), drawPda.toBuffer(), u.publicKey.toBuffer(), idxBuf],
          program.programId
        )[0];

        // Random numbers
        var nums = new Set<number>();
        while (nums.size < 6) nums.add(Math.floor(Math.random() * 72) + 1);
        var cry = Math.floor(Math.random() * 10) + 1;

        try {
          await retryAsync(async function() {
            await (program.methods.buyTicket(Array.from(nums), cry).accounts)({
              user: u.publicKey, globalState: gs, drawState: drawPda,
              userDrawState: uds, ticket: tPda,
              userTokenAccount: uAta, prizeVault: pv,
              tokenProgram: TP, systemProgram: SystemProgram.programId
            }).signers([u]).rpc();
          }, "buy-ticket-" + ui + "-" + mi, batchErrors);

          allTicketPdas.push(tPda);
          cp.ticketPdas.push(tPda.toBase58());
          cp.ticketsBought++;
          ticketsThisUser++;
        } catch (e: any) {
          var errMsg = (e.message || "").slice(0, 80);
          // If "already in use" — ticket already exists (resume scenario)
          if (errMsg.indexOf("already in use") !== -1) {
            allTicketPdas.push(tPda);
            if (cp.ticketPdas.indexOf(tPda.toBase58()) === -1) {
              cp.ticketPdas.push(tPda.toBase58());
            }
            cp.ticketsBought++;
            ticketsThisUser++;
            log("SKIP", "Ticket " + ui + "-" + mi + " already exists (resumed)");
          } else {
            logErr("FAIL", "Ticket " + ui + "-" + mi + ": " + errMsg);
          }
        }

        await sleep(DELAY_BETWEEN_BUYS_MS);
      }

      cp.usersCompleted = ui + 1;

      // === Log progress ===
      if ((ui + 1) % WALLET_BATCH_SIZE === 0 || ui === USERS_NEEDED - 1) {
        log("BUY", cp.ticketsBought + "/" + TICKETS + " tickets | wallet " + (ui + 1) + "/" + USERS_NEEDED);

        // Save checkpoint every batch
        saveCheckpoint(cp);
      }
    }

    // Mark buy phase complete
    cp.phase = "settle";
    saveCheckpoint(cp);

    var buyElapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
    log("DONE", "Buy phase complete: " + cp.ticketsBought + " tickets in " + buyElapsed + "s");
    if (batchErrors.length > 0) {
      log("WARN", batchErrors.length + " errors during buy phase");
      for (var ei = 0; ei < Math.min(batchErrors.length, 10); ei++) {
        logErr("ERR", batchErrors[ei]);
      }
    }
    console.log("");
  }

  // Reconstruct allTicketPdas from checkpoint if needed
  if (allTicketPdas.length === 0 && cp.ticketPdas.length > 0) {
    for (var ri = 0; ri < cp.ticketPdas.length; ri++) {
      allTicketPdas.push(new PublicKey(cp.ticketPdas[ri]));
    }
  }

  // ================================================================
  // PHASE: RANDOMNESS + CLOSE
  // ================================================================
  if (startPhase === "buy" || startPhase === "settle") {
    // Check if draw is already closed
    var drawData = await program.account.draw.fetch(drawPda);
    var drawStatus = Number(drawData.status);

    if (drawStatus < 2) {
      // Need to close draw (randomness + close)
      step(3, "RANDOMNESS (" + MODE + ")");

      var rKp = Keypair.generate();

      // Check if randomness already requested
      var rRequested = pick(drawData, "randomnessRequested", "randomness_requested");
      if (!rRequested) {
        await retryAsync(async function() {
          await (program.methods.requestRandomness().accounts)({
            draw: drawPda, randomnessAccount: rKp.publicKey
          }).rpc();
        }, "request_randomness", cp.errors);
        log("OK", "Randomness requested");
      } else {
        log("SKIP", "Randomness already requested");
        // Read the existing randomness account
        rKp = { publicKey: pick(drawData, "randomnessAccount", "randomness_account") };
      }

      // Fulfill
      var rFulfilled = pick(drawData, "randomnessFulfilled", "randomness_fulfilled");
      if (!rFulfilled) {
        if (MODE === "test") {
          var seed: number[] = [];
          for (var ms = 0; ms < 32; ms++) seed.push(Math.floor(Math.random() * 256));
          await retryAsync(async function() {
            await (program.methods.fulfillRandomness(seed).accounts)({
              admin: wallet.publicKey, globalState: gs, draw: drawPda
            }).rpc();
          }, "fulfill_randomness", cp.errors);
          log("OK", "Fulfilled (test seed)");
        } else {
          log("WAIT", "Waiting 15s for Switchboard VRF...");
          await sleep(15000);
        }
      } else {
        log("SKIP", "Randomness already fulfilled");
      }
      console.log("");

      // Close draw
      step(4, "CLOSE DRAW");
      var raKey = typeof rKp.publicKey === "string" ? new PublicKey(rKp.publicKey) : rKp.publicKey;
      var cIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });
      await retryAsync(async function() {
        await (program.methods.closeDraw().accounts)({
          globalState: gs, draw: drawPda, randomnessAccountData: raKey
        }).preInstructions([cIx]).rpc();
      }, "close_draw", cp.errors);

      var dc = await program.account.draw.fetch(drawPda);
      log("OK", "Closed");
      log("RESULT", "Numbers: " + String(pick(dc, "resultNumbers", "result_numbers")));
      log("RESULT", "Crypto:  " + String(pick(dc, "resultCrypto", "result_crypto")));
      console.log("");

    } else {
      log("SKIP", "Draw already closed (status=" + drawStatus + ")");
      console.log("");
    }
  }

  // ================================================================
  // PHASE: SETTLE TICKETS
  // ================================================================
  if (startPhase === "buy" || startPhase === "settle") {
    step(5, "SETTLE " + allTicketPdas.length + " TICKETS");

    // Check current settlement status
    var dSetCheck = await program.account.draw.fetch(drawPda);
    var alreadyProcessed = Number(pick(dSetCheck, "ticketsProcessed", "tickets_processed") || 0);
    var settlementDone = pick(dSetCheck, "settlementComplete", "settlement_complete");

    if (settlementDone) {
      log("SKIP", "Settlement already complete (" + alreadyProcessed + " tickets)");
    } else {
      // Figure out which tickets still need settling
      // We start from the beginning but settled tickets will be skipped by the program
      var settleStart = Date.now();
      var off = 0;

      while (off < allTicketPdas.length) {
        var end = Math.min(off + BATCH_SETTLE, allTicketPdas.length);
        var rem: any[] = [];
        for (var j = off; j < end; j++) {
          rem.push({ pubkey: allTicketPdas[j], isWritable: true, isSigner: false });
        }

        try {
          await retryAsync(async function() {
            await (program.methods.settleTickets(rem.length).accounts)({
              draw: drawPda
            }).remainingAccounts(rem).rpc();
          }, "settle-batch-" + off, cp.errors);
        } catch (e: any) {
          logErr("SETTLE", "Batch at offset " + off + " failed: " + (e.message || "").slice(0, 80));
        }

        off = end;
        if (off % 100 === 0 || off >= allTicketPdas.length) {
          log("SETTLE", off + "/" + allTicketPdas.length);
        }
        await sleep(DELAY_BETWEEN_SETTLE_MS);
      }

      var settleElapsed = ((Date.now() - settleStart) / 1000).toFixed(1);
      log("DONE", "Settlement complete in " + settleElapsed + "s");
    }

    var ds = await program.account.draw.fetch(drawPda);
    var wc = pick(ds, "winnerCounts", "winner_counts") || [];
    var tw = 0;
    for (var w = 0; w < wc.length; w++) tw += Number(wc[w]);
    log("WINNERS", tw + " total | " + String(wc));
    console.log("");

    cp.phase = "finalize";
    saveCheckpoint(cp);
  }

  // ================================================================
  // PHASE: FINALIZE PAYOUTS
  // ================================================================
  if (startPhase === "buy" || startPhase === "settle" || startPhase === "finalize") {
    step(6, "FINALIZE PAYOUTS");

    var dFinCheck = await program.account.draw.fetch(drawPda);
    var finStatus = Number(dFinCheck.status);

    if (finStatus >= 3) {
      log("SKIP", "Payouts already finalized (status=" + finStatus + ")");
    } else {
      await retryAsync(async function() {
        await (program.methods.finalizePayouts().accounts)({
          globalState: gs, draw: drawPda
        }).rpc();
      }, "finalize_payouts", cp.errors);
      log("OK", "Finalized");
    }

    var df = await program.account.draw.fetch(drawPda);
    log("PRIZES", String(pick(df, "prizePerTier", "prize_per_tier")));
    log("MONTHLY", "Rollover: " + String(pick(df, "monthlyRolloverContribution", "monthly_rollover_contribution") || 0));
    console.log("");

    cp.phase = "pay";
    saveCheckpoint(cp);
  }

  // ================================================================
  // PHASE: PAY WINNERS
  // ================================================================
  if (startPhase === "buy" || startPhase === "settle" || startPhase === "finalize" || startPhase === "pay") {
    step(7, "PAY WINNERS");

    // Check if already paid
    var dPayCheck = await program.account.draw.fetch(drawPda);
    var alreadyPaid = pick(dPayCheck, "isPaid", "is_paid");

    if (alreadyPaid) {
      log("SKIP", "Draw already fully paid");
    } else {
      // Scan ticket PDAs for winners
      var winners: any[] = [];
      log("INFO", "Scanning " + allTicketPdas.length + " tickets for winners...");

      for (var ki = 0; ki < allTicketPdas.length; ki++) {
        try {
          var t = await program.account.ticket.fetch(allTicketPdas[ki]);
          if (t.tier <= 9 && !t.paid) {
            winners.push({ publicKey: allTicketPdas[ki], account: t });
          }
        } catch (e) { continue; }

        // Rate limit protection: don't hammer RPC with fetches
        if (ki % 50 === 0 && ki > 0) await sleep(100);
      }

      log("INFO", "Found " + winners.length + " unpaid winners");

      var paidCount = 0;
      for (var pi = 0; pi < winners.length; pi++) {
        var wt = winners[pi];
        var wo = wt.account.owner;
        if (!wo) continue;
        var wa = getAssociatedTokenAddressSync(MINT, wo, false, TP);

        try {
          await retryAsync(async function() {
            await (program.methods.payWinnersBatch(1).accounts)({
              draw: drawPda, ticket: wt.publicKey, globalState: gs,
              prizeVault: pv, userTokenAccount: wa, vaultAuthority: va,
              tokenProgram: TP
            }).rpc();
          }, "pay-winner-" + pi, cp.errors);
          paidCount++;
        } catch (e: any) {
          var pm = (e.message || "");
          if (pm.indexOf("AlreadyPaid") === -1) {
            logErr("PAY", "Winner " + pi + ": " + pm.slice(0, 80));
          } else {
            paidCount++;  // already paid counts
          }
        }

        if (paidCount % 10 === 0 || pi === winners.length - 1) {
          log("PAY", paidCount + "/" + winners.length);
        }
        await sleep(DELAY_BETWEEN_PAY_MS);
      }

      // Zero winners fast-path
      if (winners.length === 0 && allTicketPdas.length > 0) {
        var fpOwner = allWallets.length > 0 ? allWallets[0].publicKey : null;
        if (fpOwner) {
          var fpAta = getAssociatedTokenAddressSync(MINT, fpOwner, false, TP);
          try {
            await (program.methods.payWinnersBatch(1).accounts)({
              draw: drawPda, ticket: allTicketPdas[0], globalState: gs,
              prizeVault: pv, userTokenAccount: fpAta, vaultAuthority: va,
              tokenProgram: TP
            }).rpc();
            log("OK", "Fast-path (zero winners)");
          } catch (e: any) {
            log("INFO", "Fast-path: " + ((e.message || "").slice(0, 60)));
          }
        }
      }

      log("DONE", "Paid " + paidCount + " winner(s)");
    }

    console.log("");
    cp.phase = "done";
    saveCheckpoint(cp);
  }

  // ================================================================
  // FINAL REPORT
  // ================================================================
  var totalElapsed = ((Date.now() - globalStartTime) / 1000).toFixed(1);
  var endBal = await conn.getBalance(wallet.publicKey);
  var endToken = Number((await getAccount(conn, adminAta, "confirmed", TP)).amount);
  var dFinal = await program.account.draw.fetch(drawPda);
  var gFinal = await program.account.globalState.fetch(gs);

  console.log("");
  hr();
  console.log("  DRAW #" + drawId.toString() + " — FINAL REPORT (" + TICKETS + " tickets)");
  hr();
  console.log("");
  console.log("  draw_id:              " + String(dFinal.id));
  console.log("  draw_pda:             " + drawPda.toBase58());
  console.log("  status:               " + String(dFinal.status));
  console.log("  result_numbers:       " + String(pick(dFinal, "resultNumbers", "result_numbers")));
  console.log("  result_crypto:        " + String(pick(dFinal, "resultCrypto", "result_crypto")));
  console.log("  tickets_sold:         " + String(pick(dFinal, "ticketsSold", "tickets_sold")));
  console.log("  tickets_processed:    " + String(pick(dFinal, "ticketsProcessed", "tickets_processed")));
  console.log("  settlement_complete:  " + String(pick(dFinal, "settlementComplete", "settlement_complete")));
  console.log("  winner_counts:        " + String(pick(dFinal, "winnerCounts", "winner_counts")));
  console.log("  prize_per_tier:       " + String(pick(dFinal, "prizePerTier", "prize_per_tier")));
  console.log("  tickets_paid:         " + String(pick(dFinal, "ticketsPaid", "tickets_paid")));
  console.log("  is_paid:              " + String(pick(dFinal, "isPaid", "is_paid")));
  console.log("  monthly_rollover:     " + String(pick(dFinal, "monthlyRolloverContribution", "monthly_rollover_contribution") || 0));
  console.log("");
  console.log("  === ECONOMICS ===");
  console.log("  monthly_pool:         " + String(pick(gFinal, "monthlyPool", "monthly_pool")));
  console.log("  daily_total:          " + String(pick(gFinal, "dailyTotal", "daily_total")));
  console.log("  referral_total:       " + String(pick(gFinal, "referralTotal", "referral_total")));
  console.log("");
  console.log("  === COST REPORT ===");
  console.log("  Admin SOL start:      " + (adminBal / LAMPORTS_PER_SOL).toFixed(4));
  console.log("  Admin SOL end:        " + (endBal / LAMPORTS_PER_SOL).toFixed(4));
  console.log("  SOL spent:            " + ((adminBal - endBal) / LAMPORTS_PER_SOL).toFixed(4));
  console.log("  SOL per ticket:       " + (((adminBal - endBal) / LAMPORTS_PER_SOL) / cp.ticketsBought).toFixed(4));
  console.log("  Token start:          " + adminToken);
  console.log("  Token end:            " + endToken);
  console.log("  Token spent:          " + (adminToken - endToken));
  console.log("  Time elapsed:         " + totalElapsed + "s (" + (parseFloat(totalElapsed) / 60).toFixed(1) + " min)");
  console.log("  Avg time/ticket:      " + (parseFloat(totalElapsed) / cp.ticketsBought).toFixed(2) + "s");
  console.log("");

  if (cp.errors.length > 0) {
    console.log("  === ERRORS (" + cp.errors.length + ") ===");
    for (var err = 0; err < Math.min(cp.errors.length, 20); err++) {
      console.log("  " + cp.errors[err]);
    }
    console.log("");
  }

  console.log("  Checkpoint: " + CHECKPOINT_FILE);
  console.log("  Explorer:   https://explorer.solana.com/address/" + drawPda.toBase58() + "?cluster=devnet");
  console.log("");
  hr();
  console.log("  MegaByt. Provably fair. Fully on-chain. " + TICKETS + " tickets validated.");
  hr();
  console.log("");
}

main().catch(function(e: any) {
  console.error("");
  console.error("  FATAL ERROR: " + (e.message || e));
  if (e.logs) {
    for (var i = 0; i < Math.min(e.logs.length, 15); i++) {
      console.error("  " + e.logs[i]);
    }
  }
  console.error("");
  console.error("  Checkpoint saved. Re-run the same command to resume.");
  console.error("");
  process.exit(1);
});
