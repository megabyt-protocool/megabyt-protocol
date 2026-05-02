import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

var TICKET_COUNT = parseInt(process.env.TICKET_COUNT || "10", 10);
var DRAW_DURATION = new anchor.BN(process.env.DRAW_DURATION || "300");

function log(tag: string, msg: string): void {
  console.log("  [" + tag + "] " + msg);
}

function hr(): void {
  console.log("========================================================");
}

async function confirmTx(provider: anchor.AnchorProvider, sig: string): Promise<void> {
  var bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
}

function sleep(ms: number): Promise<void> {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function pick(obj: any, k1: string, k2: string): any {
  if (obj[k1] !== undefined && obj[k1] !== null) return obj[k1];
  if (obj[k2] !== undefined && obj[k2] !== null) return obj[k2];
  return null;
}

async function detectTP(connection: anchor.web3.Connection, mint: PublicKey): Promise<PublicKey> {
  var info = await connection.getAccountInfo(mint);
  if (!info) throw new Error("Mint not found");
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function ensureAta(connection: anchor.web3.Connection, payer: Keypair, mint: PublicKey, owner: PublicKey, tp: PublicKey): Promise<PublicKey> {
  var ata = getAssociatedTokenAddressSync(mint, owner, false, tp);
  try { await getAccount(connection, ata, "confirmed", tp); } catch (e) {
    var ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, tp);
    var tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer]);
  }
  return ata;
}

(async function() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = (anchor.workspace as any).Megabyt;
  var wallet = (provider.wallet as anchor.Wallet).payer;
  var connection = provider.connection;

  console.log("");
  hr();
  console.log("  MEGABYT PROTOCOL -- FULL E2E DEMO");
  console.log("  On-Chain Lottery | Solana Devnet");
  hr();
  console.log("");
  console.log("  Program:  " + program.programId.toBase58());
  console.log("  Operator: " + wallet.publicKey.toBase58());
  console.log("  Tickets:  " + TICKET_COUNT);
  console.log("");

  // Bootstrap
  var gsRes = PublicKey.findProgramAddressSync([Buffer.from("global-state-v3")], program.programId);
  var globalState = gsRes[0];
  var vaRes = PublicKey.findProgramAddressSync([Buffer.from("vault-authority-v3")], program.programId);
  var vaultAuthority = vaRes[0];

  var globalData = await program.account.globalState.fetch(globalState);
  var prizeVault: PublicKey = pick(globalData, "prizeVault", "prize_vault");
  var vaultAcct = await getAccount(connection, prizeVault);
  var MINT = vaultAcct.mint;
  var TP = await detectTP(connection, MINT);
  var currentDrawId = Number(pick(globalData, "currentDrawId", "current_draw_id") || 0);

  log("BOOT", "GlobalState:  " + globalState.toBase58());
  log("BOOT", "PrizeVault:   " + prizeVault.toBase58());
  log("BOOT", "Mint:         " + MINT.toBase58());
  log("BOOT", "DrawID:       " + currentDrawId);
  console.log("");

  // Step 1: Open Draw
  hr();
  console.log("  STEP 1: OPEN DRAW");
  hr();
  var nextId = currentDrawId + 1;
  var drawRes = PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), new anchor.BN(nextId).toArrayLike(Buffer, "le", 8)], program.programId);
  var drawPda = drawRes[0];

  var txO = await (program.methods.openDraw(DRAW_DURATION).accounts as any)({
    admin: wallet.publicKey, globalState, drawState: drawPda, systemProgram: SystemProgram.programId
  }).rpc();
  await confirmTx(provider, txO);

  var gAfter = await program.account.globalState.fetch(globalState);
  var drawId = Number(pick(gAfter, "currentDrawId", "current_draw_id"));
  drawRes = PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), new anchor.BN(drawId).toArrayLike(Buffer, "le", 8)], program.programId);
  drawPda = drawRes[0];

  log("OK", "Draw #" + drawId + " opened");
  log("PDA", drawPda.toBase58());
  console.log("");

  // Step 2: Fund users + buy tickets
  hr();
  console.log("  STEP 2: BUY " + TICKET_COUNT + " TICKETS");
  hr();

  var adminAta = await ensureAta(connection, wallet, MINT, wallet.publicKey, TP);
  var users: Keypair[] = [];
  var userAtas: PublicKey[] = [];
  var ticketPdas: PublicKey[] = [];

  for (var i = 0; i < TICKET_COUNT; i++) {
    var u = Keypair.generate();
    users.push(u);

    // Fund SOL
    var solTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: u.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    await sendAndConfirmTransaction(connection, solTx, [wallet]);

    // Fund token
    var uAta = await ensureAta(connection, wallet, MINT, u.publicKey, TP);
    userAtas.push(uAta);
    var xIx = createTransferInstruction(adminAta, uAta, wallet.publicKey, 1000000, [], TP);
    var xTx = new Transaction().add(xIx);
    await sendAndConfirmTransaction(connection, xTx, [wallet]);

    // Buy ticket
    var tRes = PublicKey.findProgramAddressSync([Buffer.from("ticket"), drawPda.toBuffer(), u.publicKey.toBuffer()], program.programId);
    var tPda = tRes[0];
    ticketPdas.push(tPda);

    var nums = new Set<number>();
    while (nums.size < 6) nums.add(Math.floor(Math.random() * 72) + 1);
    var cry = Math.floor(Math.random() * 10) + 1;

    var txB = await (program.methods.buyTicket(Array.from(nums), cry).accounts as any)({
      user: u.publicKey, globalState, drawState: drawPda, ticket: tPda,
      userTokenAccount: uAta, prizeVault, tokenProgram: TP, systemProgram: SystemProgram.programId
    }).signers([u]).rpc();
    await confirmTx(provider, txB);

    if ((i + 1) % 5 === 0 || i === TICKET_COUNT - 1) {
      log("BUY", (i + 1) + "/" + TICKET_COUNT + " tickets");
    }
    await sleep(200);
  }
  console.log("");

  // Step 3: Request Randomness
  hr();
  console.log("  STEP 3: REQUEST RANDOMNESS (VRF)");
  hr();

  var rKp = Keypair.generate();
  var txR = await (program.methods.requestRandomness().accounts as any)({
    draw: drawPda, randomnessAccount: rKp.publicKey
  }).rpc();
  await confirmTx(provider, txR);
  log("OK", "Randomness requested");
  log("VRF", "Account: " + rKp.publicKey.toBase58());
  console.log("");

  // Step 4: Wait + Close Draw
  hr();
  console.log("  STEP 4: CLOSE DRAW (WAIT FOR VRF)");
  hr();

  log("WAIT", "Waiting 15s for Switchboard oracle...");
  await sleep(15000);

  var cIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });
  try {
    var txC = await (program.methods.closeDraw().accounts as any)({
      globalState, draw: drawPda, randomnessAccountData: rKp.publicKey
    }).preInstructions([cIx]).rpc();
    await confirmTx(provider, txC);
    log("OK", "Draw closed with VRF");
  } catch (e: any) {
    log("RETRY", "First attempt failed. Waiting 15s more...");
    await sleep(15000);
    var txC2 = await (program.methods.closeDraw().accounts as any)({
      globalState, draw: drawPda, randomnessAccountData: rKp.publicKey
    }).preInstructions([cIx]).rpc();
    await confirmTx(provider, txC2);
    log("OK", "Draw closed with VRF (retry)");
  }

  var dClose = await program.account.draw.fetch(drawPda);
  log("RESULT", "Numbers: " + String(dClose.resultNumbers || dClose.result_numbers));
  log("RESULT", "Crypto:  " + String(dClose.resultCrypto || dClose.result_crypto));
  console.log("");

  // Step 5: Settle
  hr();
  console.log("  STEP 5: SETTLE TICKETS");
  hr();

  var offset = 0;
  while (offset < ticketPdas.length) {
    var end = Math.min(offset + 20, ticketPdas.length);
    var rem: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> = [];
    for (var j = offset; j < end; j++) {
      rem.push({ pubkey: ticketPdas[j], isWritable: true, isSigner: false });
    }
    var txS = await (program.methods.settleTickets(rem.length).accounts as any)({
      draw: drawPda
    }).remainingAccounts(rem).rpc();
    await confirmTx(provider, txS);
    offset = end;
    log("SETTLE", offset + "/" + ticketPdas.length);
    await sleep(300);
  }

  var dSettle = await program.account.draw.fetch(drawPda);
  log("WINNERS", String(dSettle.winnerCounts || dSettle.winner_counts));
  console.log("");

  // Step 6: Finalize
  hr();
  console.log("  STEP 6: FINALIZE PAYOUTS (CASCADE)");
  hr();

  var txF = await (program.methods.finalizePayouts().accounts as any)({
    globalState, draw: drawPda
  }).rpc();
  await confirmTx(provider, txF);
  log("OK", "Payouts finalized");

  var dFin = await program.account.draw.fetch(drawPda);
  log("PRIZES", String(dFin.prizePerTier || dFin.prize_per_tier));
  console.log("");

  // Step 7: Pay Winners
  hr();
  console.log("  STEP 7: PAY WINNERS");
  hr();

  var allTickets = await program.account.ticket.all();
  var winners: Array<{ publicKey: PublicKey; account: any }> = [];
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
      var txP = await (program.methods.payWinnersBatch(1).accounts as any)({
        draw: drawPda, ticket: wt.publicKey, globalState, prizeVault,
        userTokenAccount: wAta, vaultAuthority, tokenProgram: TP
      }).rpc();
      await confirmTx(provider, txP);
      paidCount++;
      log("PAY", "Tier " + wt.account.tier + " -> " + wOwner.toBase58().slice(0, 12));
    } catch (e: any) {
      var em = e.message || "";
      if (em.indexOf("AlreadyPaid") === -1 && em.indexOf("NotAWinner") === -1) {
        log("ERR", em.slice(0, 80));
      }
    }
    await sleep(200);
  }

  if (winners.length === 0) {
    log("INFO", "Zero winners. Calling fast-path...");
    if (ticketPdas.length > 0) {
      var fp = ticketPdas[0];
      var fpOwner = users[0].publicKey;
      var fpAta = getAssociatedTokenAddressSync(MINT, fpOwner, false, TP);
      try {
        await (program.methods.payWinnersBatch(1).accounts as any)({
          draw: drawPda, ticket: fp, globalState, prizeVault,
          userTokenAccount: fpAta, vaultAuthority, tokenProgram: TP
        }).rpc();
      } catch (e) {}
    }
  }

  console.log("");

  // Final Report
  hr();
  console.log("  DRAW #" + drawId + " COMPLETE");
  hr();
  console.log("");

  var dFinal = await program.account.draw.fetch(drawPda);
  console.log("  Status:          " + dFinal.status);
  console.log("  Numbers:         " + String(dFinal.resultNumbers || dFinal.result_numbers));
  console.log("  Crypto:          " + String(dFinal.resultCrypto || dFinal.result_crypto));
  console.log("  Tickets:         " + String(pick(dFinal, "ticketsSold", "tickets_sold")));
  console.log("  Winners:         " + String(dFinal.winnerCounts || dFinal.winner_counts));
  console.log("  Prizes/tier:     " + String(dFinal.prizePerTier || dFinal.prize_per_tier));
  console.log("  Paid:            " + paidCount + " winners");
  console.log("  Is Paid:         " + String(pick(dFinal, "isPaid", "is_paid")));
  console.log("");
  console.log("  Explorer: https://explorer.solana.com/address/" + drawPda.toBase58() + "?cluster=devnet");
  console.log("");
  hr();
  console.log("  MegaByt. Provably fair. Fully on-chain.");
  hr();
  console.log("");
})();
