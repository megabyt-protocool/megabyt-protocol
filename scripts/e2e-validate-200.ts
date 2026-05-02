import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

var IDL = require("../target/idl/megabyt.json");
var TICKET_COUNT = 200;
var SOL_PER_USER = 0.008 * LAMPORTS_PER_SOL;
var SOL_BATCH = 10;
var BUY_LOG_INTERVAL = 10;
var SETTLE_BATCH = 20;

function log(s, m) { console.log("  [" + s + "] " + m); }
function hr() { console.log("========================================================"); }

async function confirmTx(conn, sig) {
  var bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function pick(obj, k1, k2) {
  if (obj[k1] !== undefined && obj[k1] !== null) return obj[k1];
  if (obj[k2] !== undefined && obj[k2] !== null) return obj[k2];
  return null;
}

async function detectTP(conn, mint) {
  var info = await conn.getAccountInfo(mint);
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function ensureAta(conn, payer, mint, owner, tp) {
  var ata = getAssociatedTokenAddressSync(mint, owner, false, tp);
  try { await getAccount(conn, ata, "confirmed", tp); } catch (e) {
    var ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, tp);
    var tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(conn, tx, [payer]);
  }
  return ata;
}

async function main() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = new anchor.Program(IDL, provider);
  var wallet = (provider.wallet).payer;
  var conn = provider.connection;
  var startTime = Date.now();

  console.log("");
  hr();
  console.log("  E2E STRESS TEST - " + TICKET_COUNT + " TICKETS");
  hr();
  console.log("");
  console.log("  Program: " + program.programId.toBase58());
  console.log("  Wallet:  " + wallet.publicKey.toBase58());
  console.log("");

  // Bootstrap
  var gsRes = PublicKey.findProgramAddressSync([Buffer.from("global-state-v3")], program.programId);
  var globalState = gsRes[0];
  var vaRes = PublicKey.findProgramAddressSync([Buffer.from("vault-authority-v3")], program.programId);
  var vaultAuthority = vaRes[0];

  var globalData = await program.account.globalState.fetch(globalState);
  var prizeVault = pick(globalData, "prizeVault", "prize_vault");
  var ticketPrice = Number(pick(globalData, "ticketPrice", "ticket_price"));
  var vaultAcct = await getAccount(conn, prizeVault);
  var MINT = vaultAcct.mint;
  var TP = await detectTP(conn, MINT);
  var currentDrawId = Number(pick(globalData, "currentDrawId", "current_draw_id") || 0);

  var adminBalStart = await conn.getBalance(wallet.publicKey);
  var adminAtaStart = await ensureAta(conn, wallet, MINT, wallet.publicKey, TP);
  var adminTokenStart = Number((await getAccount(conn, adminAtaStart, "confirmed", TP)).amount);

  log("BOOT", "GlobalState:  " + globalState.toBase58());
  log("BOOT", "PrizeVault:   " + prizeVault.toBase58());
  log("BOOT", "Mint:         " + MINT.toBase58());
  log("BOOT", "TicketPrice:  " + ticketPrice);
  log("BOOT", "TokenProgram: " + TP.toBase58());
  log("BOOT", "DrawID:       " + currentDrawId);
  log("COST", "Admin SOL:    " + (adminBalStart / LAMPORTS_PER_SOL).toFixed(4));
  log("COST", "Admin USDT:   " + adminTokenStart);
  log("COST", "SOL/user:     " + (SOL_PER_USER / LAMPORTS_PER_SOL));
  log("COST", "Est SOL needed: " + ((TICKET_COUNT * SOL_PER_USER / LAMPORTS_PER_SOL) + 0.5).toFixed(2));
  log("COST", "Est USDT needed: " + (TICKET_COUNT * ticketPrice));
  console.log("");

  // Check balances
  var solNeeded = TICKET_COUNT * SOL_PER_USER + 0.5 * LAMPORTS_PER_SOL;
  if (adminBalStart < solNeeded) {
    console.error("  Need ~" + (solNeeded / LAMPORTS_PER_SOL).toFixed(2) + " SOL. Have " + (adminBalStart / LAMPORTS_PER_SOL).toFixed(4));
    process.exit(1);
  }
  var usdtNeeded = TICKET_COUNT * ticketPrice;
  if (adminTokenStart < usdtNeeded) {
    console.error("  Need " + usdtNeeded + " USDT tokens. Have " + adminTokenStart);
    console.error("  Mint: spl-token mint " + MINT.toBase58() + " " + usdtNeeded);
    process.exit(1);
  }

  // Step 1: Open draw
  hr();
  console.log("  STEP 1: OPEN DRAW");
  hr();

  var nextId = new BN(currentDrawId).add(new BN(1));
  var drawPreRes = PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), nextId.toArrayLike(Buffer, "le", 8)], program.programId);
  var drawPre = drawPreRes[0];

  var txO = await (program.methods.openDraw(new BN(3600)).accounts)({
    admin: wallet.publicKey,
    globalState: globalState,
    drawState: drawPre,
    systemProgram: SystemProgram.programId
  }).rpc();
  await confirmTx(conn, txO);

  var gAfter = await program.account.globalState.fetch(globalState);
  var drawId = new BN(pick(gAfter, "currentDrawId", "current_draw_id"));
  var drawRes = PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), drawId.toArrayLike(Buffer, "le", 8)], program.programId);
  var drawPda = drawRes[0];

  log("OK", "Draw #" + drawId.toString() + " opened");
  log("PDA", drawPda.toBase58());
  console.log("");

  // Step 2: Generate users + fund SOL in batches
  hr();
  console.log("  STEP 2: FUND " + TICKET_COUNT + " USERS");
  hr();

  var users = [];
  for (var gi = 0; gi < TICKET_COUNT; gi++) { users.push(Keypair.generate()); }

  for (var si = 0; si < users.length; si += SOL_BATCH) {
    var end = Math.min(si + SOL_BATCH, users.length);
    var solTx = new Transaction();
    for (var sj = si; sj < end; sj++) {
      solTx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: users[sj].publicKey, lamports: SOL_PER_USER }));
    }
    await sendAndConfirmTransaction(conn, solTx, [wallet]);
    if (end % 50 === 0 || end === users.length) {
      log("SOL", end + "/" + users.length);
    }
    await sleep(100);
  }
  console.log("");

  // Step 3: Fund tokens + buy tickets
  hr();
  console.log("  STEP 3: BUY " + TICKET_COUNT + " TICKETS");
  hr();

  var adminAta = await ensureAta(conn, wallet, MINT, wallet.publicKey, TP);
  var userAtas = [];
  var ticketPdas = [];

  for (var i = 0; i < TICKET_COUNT; i++) {
    var u = users[i];

    // Create ATA + fund token
    var uAta = await ensureAta(conn, wallet, MINT, u.publicKey, TP);
    userAtas.push(uAta);

    var xIx = createTransferInstruction(adminAta, uAta, wallet.publicKey, ticketPrice, [], TP);
    var xTx = new Transaction().add(xIx);
    await sendAndConfirmTransaction(conn, xTx, [wallet]);

    // Buy ticket
    var tRes = PublicKey.findProgramAddressSync([Buffer.from("ticket"), drawPda.toBuffer(), u.publicKey.toBuffer()], program.programId);
    var tPda = tRes[0];
    ticketPdas.push(tPda);

    var nums = new Set();
    while (nums.size < 6) nums.add(Math.floor(Math.random() * 72) + 1);
    var cry = Math.floor(Math.random() * 10) + 1;

    var txB = await (program.methods.buyTicket(Array.from(nums), cry).accounts)({
      user: u.publicKey,
      globalState: globalState,
      drawState: drawPda,
      ticket: tPda,
      userTokenAccount: uAta,
      prizeVault: prizeVault,
      tokenProgram: TP,
      systemProgram: SystemProgram.programId
    }).signers([u]).rpc();
    await confirmTx(conn, txB);

    if ((i + 1) % BUY_LOG_INTERVAL === 0 || i === TICKET_COUNT - 1) {
      log("BUY", (i + 1) + "/" + TICKET_COUNT);
    }
    await sleep(150);
  }
  console.log("");

  // Step 4: Request + fulfill randomness
  hr();
  console.log("  STEP 4: RANDOMNESS");
  hr();

  var rKp = Keypair.generate();
  await (program.methods.requestRandomness().accounts)({
    draw: drawPda, randomnessAccount: rKp.publicKey
  }).rpc();
  log("OK", "Randomness requested");

  var mockSeed = [];
  for (var ms = 0; ms < 32; ms++) { mockSeed.push(Math.floor(Math.random() * 256)); }
  await (program.methods.fulfillRandomness(mockSeed).accounts)({
    admin: wallet.publicKey, globalState: globalState, draw: drawPda
  }).rpc();
  log("OK", "Randomness fulfilled (test seed)");
  console.log("");

  // Step 5: Close draw
  hr();
  console.log("  STEP 5: CLOSE DRAW");
  hr();

  var cIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });
  var txC = await (program.methods.closeDraw().accounts)({
    globalState: globalState, draw: drawPda, randomnessAccountData: rKp.publicKey
  }).preInstructions([cIx]).rpc();
  await confirmTx(conn, txC);
  log("OK", "Draw closed");

  var dClose = await program.account.draw.fetch(drawPda);
  log("RESULT", "Numbers: " + String(pick(dClose, "resultNumbers", "result_numbers")));
  log("RESULT", "Crypto:  " + String(pick(dClose, "resultCrypto", "result_crypto")));
  console.log("");

  // Step 6: Settle tickets in batches
  hr();
  console.log("  STEP 6: SETTLE " + TICKET_COUNT + " TICKETS");
  hr();

  var offset = 0;
  while (offset < ticketPdas.length) {
    var bEnd = Math.min(offset + SETTLE_BATCH, ticketPdas.length);
    var rem = [];
    for (var j = offset; j < bEnd; j++) {
      rem.push({ pubkey: ticketPdas[j], isWritable: true, isSigner: false });
    }
    var txS = await (program.methods.settleTickets(rem.length).accounts)({
      draw: drawPda
    }).remainingAccounts(rem).rpc();
    await confirmTx(conn, txS);
    offset = bEnd;
    if (offset % 50 === 0 || offset === ticketPdas.length) {
      log("SETTLE", offset + "/" + ticketPdas.length);
    }
    await sleep(200);
  }

  var dSettle = await program.account.draw.fetch(drawPda);
  var wc = pick(dSettle, "winnerCounts", "winner_counts") || [];
  var totalWinners = 0;
  for (var wi = 0; wi < wc.length; wi++) { totalWinners += Number(wc[wi]); }
  log("WINNERS", totalWinners + " total | " + String(wc));
  console.log("");

  // Step 7: Finalize payouts
  hr();
  console.log("  STEP 7: FINALIZE PAYOUTS");
  hr();

  var txF = await (program.methods.finalizePayouts().accounts)({
    globalState: globalState, draw: drawPda
  }).rpc();
  await confirmTx(conn, txF);
  log("OK", "Finalized");

  var dFin = await program.account.draw.fetch(drawPda);
  log("PRIZES", String(pick(dFin, "prizePerTier", "prize_per_tier")));
  console.log("");

  // Step 8: Pay winners
  hr();
  console.log("  STEP 8: PAY WINNERS");
  hr();

  var allTickets = await program.account.ticket.all();
  var winners = [];
  for (var k = 0; k < allTickets.length; k++) {
    try {
      var tk = allTickets[k];
      if (!tk || !tk.account) continue;
      var dk = tk.account.draw || tk.account.drawState || tk.account.draw_state;
      if (!dk || typeof dk.toBase58 !== "function" || dk.toBase58() !== drawPda.toBase58()) continue;
      if (tk.account.tier <= 9 && !tk.account.paid) {
        winners.push({ publicKey: tk.publicKey || tk.pubkey, account: tk.account });
      }
    } catch (e) { continue; }
  }

  log("INFO", "Winners to pay: " + winners.length);
  var paidCount = 0;

  for (var w = 0; w < winners.length; w++) {
    var wt = winners[w];
    var wOwner = wt.account.owner || wt.account.user;
    if (!wOwner || typeof wOwner.toBase58 !== "function") continue;
    var wAta = getAssociatedTokenAddressSync(MINT, wOwner, false, TP);
    try {
      var txP = await (program.methods.payWinnersBatch(1).accounts)({
        draw: drawPda, ticket: wt.publicKey, globalState: globalState,
        prizeVault: prizeVault, userTokenAccount: wAta, vaultAuthority: vaultAuthority, tokenProgram: TP
      }).rpc();
      await confirmTx(conn, txP);
      paidCount++;
      if (paidCount % 5 === 0 || w === winners.length - 1) {
        log("PAY", paidCount + "/" + winners.length);
      }
    } catch (e) {
      var em = (e.message || "");
      if (em.indexOf("AlreadyPaid") === -1 && em.indexOf("NotAWinner") === -1) {
        log("ERR", em.slice(0, 80));
      }
    }
    await sleep(200);
  }

  if (winners.length === 0 && ticketPdas.length > 0) {
    log("INFO", "Zero winners. Fast-path...");
    var fpAta = getAssociatedTokenAddressSync(MINT, users[0].publicKey, false, TP);
    try {
      await (program.methods.payWinnersBatch(1).accounts)({
        draw: drawPda, ticket: ticketPdas[0], globalState: globalState,
        prizeVault: prizeVault, userTokenAccount: fpAta, vaultAuthority: vaultAuthority, tokenProgram: TP
      }).rpc();
      log("OK", "Fast-path done");
    } catch (e) { log("INFO", "Fast-path: " + ((e.message || "").slice(0, 60))); }
  }
  console.log("");

  // Final report
  var endTime = Date.now();
  var elapsed = ((endTime - startTime) / 1000).toFixed(1);
  var adminBalEnd = await conn.getBalance(wallet.publicKey);
  var adminTokenEnd = Number((await getAccount(conn, adminAtaStart, "confirmed", TP)).amount);

  hr();
  console.log("  DRAW #" + drawId.toString() + " - FINAL REPORT (" + TICKET_COUNT + " tickets)");
  hr();
  console.log("");

  var dFinal = await program.account.draw.fetch(drawPda);
  console.log("  draw_id:              " + String(dFinal.id));
  console.log("  draw_pda:             " + drawPda.toBase58());
  console.log("  status:               " + String(dFinal.status));
  console.log("  is_open:              " + String(pick(dFinal, "isOpen", "is_open")));
  console.log("  is_closed:            " + String(pick(dFinal, "isClosed", "is_closed")));
  console.log("  randomness_requested: " + String(pick(dFinal, "randomnessRequested", "randomness_requested")));
  console.log("  randomness_fulfilled: " + String(pick(dFinal, "randomnessFulfilled", "randomness_fulfilled")));
  console.log("  result_numbers:       " + String(pick(dFinal, "resultNumbers", "result_numbers")));
  console.log("  result_crypto:        " + String(pick(dFinal, "resultCrypto", "result_crypto")));
  console.log("  tickets_sold:         " + String(pick(dFinal, "ticketsSold", "tickets_sold")));
  console.log("  tickets_processed:    " + String(pick(dFinal, "ticketsProcessed", "tickets_processed")));
  console.log("  settlement_complete:  " + String(pick(dFinal, "settlementComplete", "settlement_complete")));
  console.log("  winner_counts:        " + String(pick(dFinal, "winnerCounts", "winner_counts")));
  console.log("  prize_per_tier:       " + String(pick(dFinal, "prizePerTier", "prize_per_tier")));
  console.log("  tickets_paid:         " + String(pick(dFinal, "ticketsPaid", "tickets_paid")));
  console.log("  is_paid:              " + String(pick(dFinal, "isPaid", "is_paid")));
  console.log("  paid_this_run:        " + paidCount);
  console.log("");
  console.log("  === COST REPORT ===");
  console.log("  Admin SOL start:      " + (adminBalStart / LAMPORTS_PER_SOL).toFixed(4));
  console.log("  Admin SOL end:        " + (adminBalEnd / LAMPORTS_PER_SOL).toFixed(4));
  console.log("  SOL spent:            " + ((adminBalStart - adminBalEnd) / LAMPORTS_PER_SOL).toFixed(4));
  console.log("  Admin USDT start:     " + adminTokenStart);
  console.log("  Admin USDT end:       " + adminTokenEnd);
  console.log("  USDT spent:           " + (adminTokenStart - adminTokenEnd));
  console.log("  Time elapsed:         " + elapsed + "s");
  console.log("  Avg time/ticket:      " + (parseFloat(elapsed) / TICKET_COUNT).toFixed(2) + "s");
  console.log("");
  console.log("  Explorer: https://explorer.solana.com/address/" + drawPda.toBase58() + "?cluster=devnet");
  console.log("");
  hr();
  console.log("  E2E STRESS TEST COMPLETE - " + TICKET_COUNT + " TICKETS");
  hr();
  console.log("");
}

main().catch(function(err) {
  console.error("ERROR: " + (err.message || err));
  if (err.logs) { for (var i = 0; i < err.logs.length; i++) { console.error("  " + err.logs[i]); } }
  process.exit(1);
});
