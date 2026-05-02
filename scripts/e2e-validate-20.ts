import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

var IDL = require("../target/idl/megabyt.json");
var TICKET_COUNT = 20;

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

  console.log("");
  hr();
  console.log("  E2E VALIDATION - 20 TICKETS (POST-REFERRAL)");
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
  var vaultAcct = await getAccount(conn, prizeVault);
  var MINT = vaultAcct.mint;
  var TP = await detectTP(conn, MINT);
  var currentDrawId = Number(pick(globalData, "currentDrawId", "current_draw_id") || 0);

  log("BOOT", "GlobalState:  " + globalState.toBase58());
  log("BOOT", "PrizeVault:   " + prizeVault.toBase58());
  log("BOOT", "Mint:         " + MINT.toBase58());
  log("BOOT", "TokenProgram: " + TP.toBase58());
  log("BOOT", "DrawID:       " + currentDrawId);
  console.log("");

  // Step 1: Open draw
  hr();
  console.log("  STEP 1: OPEN DRAW");
  hr();

  var nextId = new BN(currentDrawId).add(new BN(1));
  var drawPreRes = PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), nextId.toArrayLike(Buffer, "le", 8)], program.programId);
  var drawPre = drawPreRes[0];

  var txO = await (program.methods.openDraw(new BN(600)).accounts)({
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

  // Step 2: Fund users + buy tickets
  hr();
  console.log("  STEP 2: BUY " + TICKET_COUNT + " TICKETS");
  hr();

  var adminAta = await ensureAta(conn, wallet, MINT, wallet.publicKey, TP);

  // Check admin balance
  var adminBal = await conn.getBalance(wallet.publicKey);
  log("ADMIN", "SOL balance: " + (adminBal / LAMPORTS_PER_SOL).toFixed(4));
  var needed = TICKET_COUNT * 0.01 * LAMPORTS_PER_SOL + LAMPORTS_PER_SOL;
  if (adminBal < needed) {
    console.error("  Need ~" + (needed / LAMPORTS_PER_SOL).toFixed(2) + " SOL. Have " + (adminBal / LAMPORTS_PER_SOL).toFixed(4));
    process.exit(1);
  }

  var users = [];
  var userAtas = [];
  var ticketPdas = [];

  // Fund SOL in batches of 5
  for (var si = 0; si < TICKET_COUNT; si++) {
    users.push(Keypair.generate());
  }
  for (var bi = 0; bi < users.length; bi += 5) {
    var batch = users.slice(bi, Math.min(bi + 5, users.length));
    var solTx = new Transaction();
    for (var bj = 0; bj < batch.length; bj++) {
      solTx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: batch[bj].publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }));
    }
    await sendAndConfirmTransaction(conn, solTx, [wallet]);
    log("SOL", "Funded " + Math.min(bi + 5, users.length) + "/" + users.length);
    await sleep(200);
  }

  // Fund tokens + buy tickets
  for (var i = 0; i < TICKET_COUNT; i++) {
    var u = users[i];

    // Create ATA (admin pays)
    var uAta = await ensureAta(conn, wallet, MINT, u.publicKey, TP);
    userAtas.push(uAta);

    // Transfer token from admin to user
    var xIx = createTransferInstruction(adminAta, uAta, wallet.publicKey, 1000000, [], TP);
    var xTx = new Transaction().add(xIx);
    await sendAndConfirmTransaction(conn, xTx, [wallet]);

    // Buy ticket (normal buy_ticket, not referral)
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

    if ((i + 1) % 5 === 0 || i === TICKET_COUNT - 1) {
      log("BUY", (i + 1) + "/" + TICKET_COUNT);
    }
    await sleep(200);
  }
  console.log("");

  // Step 3: Request randomness
  hr();
  console.log("  STEP 3: REQUEST RANDOMNESS");
  hr();

  var rKp = Keypair.generate();
  var txR = await (program.methods.requestRandomness().accounts)({
    draw: drawPda,
    randomnessAccount: rKp.publicKey
  }).rpc();
  await confirmTx(conn, txR);
  log("OK", "Randomness requested");
  log("VRF", rKp.publicKey.toBase58());
  console.log("");

  // Step 3b: Fulfill randomness (test mode - pre-fill seed)
  hr();
  console.log("  STEP 3b: FULFILL RANDOMNESS (TEST MODE)");
  hr();

  var mockSeed = [];
  for (var ms = 0; ms < 32; ms++) { mockSeed.push(Math.floor(Math.random() * 256)); }

  var txFR = await (program.methods.fulfillRandomness(mockSeed).accounts)({
    admin: wallet.publicKey,
    globalState: globalState,
    draw: drawPda
  }).rpc();
  await confirmTx(conn, txFR);
  log("OK", "Randomness fulfilled (test seed)");
  console.log("");

  // Step 4: Close draw
  hr();
  console.log("  STEP 4: CLOSE DRAW");
  hr();

  var cIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });
  var txC = await (program.methods.closeDraw().accounts)({
    globalState: globalState,
    draw: drawPda,
    randomnessAccountData: rKp.publicKey
  }).preInstructions([cIx]).rpc();
  await confirmTx(conn, txC);
  log("OK", "Draw closed");

  var dClose = await program.account.draw.fetch(drawPda);
  log("RESULT", "Numbers: " + String(pick(dClose, "resultNumbers", "result_numbers")));
  log("RESULT", "Crypto:  " + String(pick(dClose, "resultCrypto", "result_crypto")));
  console.log("");

  // Step 5: Settle tickets
  hr();
  console.log("  STEP 5: SETTLE TICKETS");
  hr();

  var offset = 0;
  while (offset < ticketPdas.length) {
    var end = Math.min(offset + 20, ticketPdas.length);
    var rem = [];
    for (var j = offset; j < end; j++) {
      rem.push({ pubkey: ticketPdas[j], isWritable: true, isSigner: false });
    }
    var txS = await (program.methods.settleTickets(rem.length).accounts)({
      draw: drawPda
    }).remainingAccounts(rem).rpc();
    await confirmTx(conn, txS);
    offset = end;
    log("SETTLE", offset + "/" + ticketPdas.length);
    await sleep(300);
  }

  var dSettle = await program.account.draw.fetch(drawPda);
  log("WINNERS", String(pick(dSettle, "winnerCounts", "winner_counts")));
  console.log("");

  // Step 6: Finalize payouts
  hr();
  console.log("  STEP 6: FINALIZE PAYOUTS");
  hr();

  var txF = await (program.methods.finalizePayouts().accounts)({
    globalState: globalState,
    draw: drawPda
  }).rpc();
  await confirmTx(conn, txF);
  log("OK", "Finalized");
  console.log("");

  // Step 7: Pay winners
  hr();
  console.log("  STEP 7: PAY WINNERS");
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
        draw: drawPda,
        ticket: wt.publicKey,
        globalState: globalState,
        prizeVault: prizeVault,
        userTokenAccount: wAta,
        vaultAuthority: vaultAuthority,
        tokenProgram: TP
      }).rpc();
      await confirmTx(conn, txP);
      paidCount++;
      log("PAY", "Tier " + wt.account.tier + " -> " + wOwner.toBase58().slice(0, 12));
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
    var fpOwner = users[0].publicKey;
    var fpAta = getAssociatedTokenAddressSync(MINT, fpOwner, false, TP);
    try {
      await (program.methods.payWinnersBatch(1).accounts)({
        draw: drawPda,
        ticket: ticketPdas[0],
        globalState: globalState,
        prizeVault: prizeVault,
        userTokenAccount: fpAta,
        vaultAuthority: vaultAuthority,
        tokenProgram: TP
      }).rpc();
      log("OK", "Fast-path done");
    } catch (e) {
      log("INFO", "Fast-path: " + ((e.message || "").slice(0, 80)));
    }
  }

  console.log("");

  // Final report
  hr();
  console.log("  DRAW #" + drawId.toString() + " - FINAL REPORT");
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
  console.log("  Explorer: https://explorer.solana.com/address/" + drawPda.toBase58() + "?cluster=devnet");
  console.log("");
  hr();
  console.log("  E2E VALIDATION COMPLETE");
  hr();
  console.log("");
}

main().catch(function(err) {
  console.error("ERROR: " + (err.message || err));
  if (err.logs) {
    for (var i = 0; i < err.logs.length; i++) {
      console.error("  " + err.logs[i]);
    }
  }
  process.exit(1);
});
