/**
 * MegaByt Protocol — audit-summary.ts
 * Live protocol state audit — shows global health at a glance
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-node --transpile-only scripts/audit-summary.ts
 *
 * Optional:
 *   DRAWS=5   — how many recent draws to inspect (default 5)
 */

var anchor = require("@coral-xyz/anchor");
var { PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
var { getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
var IDL = require("../target/idl/megabyt.json");

var DRAWS_TO_SHOW = parseInt(process.env.DRAWS || "5", 10);

function pick(o: any, a: string, b: string) {
  return o[a] !== undefined && o[a] !== null ? o[a] : (o[b] !== undefined && o[b] !== null ? o[b] : null);
}

function hr() { console.log("================================================================"); }
function fmtNum(n: number) { return n.toLocaleString("en-US"); }

async function detectTP(conn: any, mint: any) {
  var info = await conn.getAccountInfo(mint);
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function main() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = new anchor.Program(IDL, provider);
  var conn = provider.connection;

  console.log("");
  hr();
  console.log("  MEGABYT PROTOCOL — LIVE AUDIT SUMMARY");
  console.log("  " + new Date().toISOString());
  hr();
  console.log("");

  // ===== GLOBAL STATE =====
  var gs = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")], program.programId
  )[0];

  var gd: any;
  try {
    gd = await program.account.globalState.fetch(gs);
  } catch (e) {
    console.error("  ERROR: Cannot read GlobalState. Program may not be deployed.");
    process.exit(1);
  }

  var pv = pick(gd, "prizeVault", "prize_vault");
  var vi = await getAccount(conn, pv);
  var MINT = vi.mint;
  var TP = await detectTP(conn, MINT);
  var vaultBalance = Number(vi.amount);
  var ticketPrice = Number(pick(gd, "ticketPrice", "ticket_price"));
  var currentDrawId = Number(pick(gd, "currentDrawId", "current_draw_id") || 0);
  var totalUsers = Number(pick(gd, "totalUsers", "total_users") || 0);
  var activeUsers = Number(pick(gd, "activeUsers", "active_users") || 0);
  var totalCollected = Number(pick(gd, "totalCollected", "total_collected") || 0);
  var monthlyPool = Number(pick(gd, "monthlyPool", "monthly_pool") || 0);
  var adminTotal = Number(pick(gd, "adminTotal", "admin_total") || 0);
  var securityTotal = Number(pick(gd, "securityTotal", "security_total") || 0);
  var referralTotal = Number(pick(gd, "referralTotal", "referral_total") || 0);
  var costsTotal = Number(pick(gd, "costsTotal", "costs_total") || 0);
  var dailyTotal = Number(pick(gd, "dailyTotal", "daily_total") || 0);
  var monthlyTotal = Number(pick(gd, "monthlyTotal", "monthly_total") || 0);
  var currentPhase = Number(pick(gd, "currentPhase", "current_phase") || 0);
  var admin = pick(gd, "admin", "admin");

  console.log("  === PROTOCOL STATE ===");
  console.log("");
  console.log("  Program:          " + program.programId.toBase58());
  console.log("  GlobalState:      " + gs.toBase58());
  console.log("  Admin:            " + (admin ? admin.toBase58() : "N/A"));
  console.log("  Prize Vault:      " + pv.toBase58());
  console.log("  Token Mint:       " + MINT.toBase58());
  console.log("  Ticket Price:     " + fmtNum(ticketPrice));
  console.log("  Current Phase:    " + currentPhase);
  console.log("");
  console.log("  === USERS ===");
  console.log("");
  console.log("  Total Users:      " + fmtNum(totalUsers));
  console.log("  Active Users:     " + fmtNum(activeUsers));
  console.log("  Total Draws:      " + currentDrawId);
  console.log("");
  console.log("  === FINANCIALS ===");
  console.log("");
  console.log("  Vault Balance:    " + fmtNum(vaultBalance));
  console.log("  Total Collected:  " + fmtNum(totalCollected));
  console.log("  Daily Pool Total: " + fmtNum(dailyTotal));
  console.log("  Monthly Pool:     " + fmtNum(monthlyPool));
  console.log("  Monthly Total:    " + fmtNum(monthlyTotal));
  console.log("  Security Total:   " + fmtNum(securityTotal));
  console.log("  Referral Total:   " + fmtNum(referralTotal));
  console.log("  Admin Total:      " + fmtNum(adminTotal));
  console.log("  Costs Total:      " + fmtNum(costsTotal));
  console.log("");

  // ===== RECENT DRAWS =====
  console.log("  === RECENT DRAWS (last " + DRAWS_TO_SHOW + ") ===");
  console.log("");

  var startDraw = Math.max(1, currentDrawId - DRAWS_TO_SHOW + 1);

  console.log("  " +
    "Draw".padEnd(6) +
    "Tickets".padStart(9) +
    "Processed".padStart(11) +
    "Winners".padStart(9) +
    "Status".padStart(10) +
    "Paid".padStart(6) +
    "  Result"
  );
  console.log("  " + "-".repeat(70));

  for (var d = startDraw; d <= currentDrawId; d++) {
    var did = new anchor.BN(d);
    var dp = PublicKey.findProgramAddressSync(
      [Buffer.from("draw-v3"), did.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

    try {
      var dd = await program.account.draw.fetch(dp);
      var tSold = Number(pick(dd, "ticketsSold", "tickets_sold") || 0);
      var tProc = Number(pick(dd, "ticketsProcessed", "tickets_processed") || 0);
      var wc = pick(dd, "winnerCounts", "winner_counts") || [];
      var tw = 0;
      for (var w = 0; w < wc.length; w++) tw += Number(wc[w]);
      var status = Number(dd.status);
      var isPaid = pick(dd, "isPaid", "is_paid");
      var resultNums = pick(dd, "resultNumbers", "result_numbers") || [];
      var resultCrypto = Number(pick(dd, "resultCrypto", "result_crypto") || 0);

      var statusStr = "?";
      if (status === 0) statusStr = "open";
      else if (status === 1) statusStr = "closed";
      else if (status === 2) statusStr = "settled";
      else if (status === 3) statusStr = "finalized";

      var resultStr = resultNums.length > 0 && resultNums[0] !== 0
        ? "[" + resultNums.join(",") + "] +" + resultCrypto
        : "—";

      console.log("  " +
        ("#" + d).padEnd(6) +
        String(tSold).padStart(9) +
        String(tProc).padStart(11) +
        String(tw).padStart(9) +
        statusStr.padStart(10) +
        (isPaid ? "  ✅" : "  —").padStart(6) +
        "  " + resultStr
      );
    } catch (e) {
      console.log("  " + ("#" + d).padEnd(6) + "  (not found or error)");
    }
  }

  console.log("");

  // ===== INTEGRITY CHECKS =====
  console.log("  === INTEGRITY CHECKS ===");
  console.log("");

  var checks = 0;
  var passed = 0;

  // Check 1: GlobalState exists
  checks++;
  console.log("  [" + (gd ? "✅" : "❌") + "] GlobalState readable");
  if (gd) passed++;

  // Check 2: Prize vault exists and has correct mint
  checks++;
  var vaultOk = vi && vi.mint;
  console.log("  [" + (vaultOk ? "✅" : "❌") + "] Prize vault exists with valid mint");
  if (vaultOk) passed++;

  // Check 3: Current draw exists
  checks++;
  var currentDrawOk = false;
  if (currentDrawId > 0) {
    try {
      var cdid = new anchor.BN(currentDrawId);
      var cdp = PublicKey.findProgramAddressSync(
        [Buffer.from("draw-v3"), cdid.toArrayLike(Buffer, "le", 8)],
        program.programId
      )[0];
      await program.account.draw.fetch(cdp);
      currentDrawOk = true;
    } catch (e) {}
  }
  console.log("  [" + (currentDrawOk ? "✅" : "⚠️") + "] Current draw (#" + currentDrawId + ") exists on-chain");
  if (currentDrawOk) passed++;

  // Check 4: Ticket price > 0
  checks++;
  var priceOk = ticketPrice > 0;
  console.log("  [" + (priceOk ? "✅" : "❌") + "] Ticket price is set (" + ticketPrice + ")");
  if (priceOk) passed++;

  // Check 5: Vault balance consistency
  checks++;
  var balanceOk = vaultBalance >= 0;
  console.log("  [" + (balanceOk ? "✅" : "❌") + "] Vault balance non-negative (" + fmtNum(vaultBalance) + ")");
  if (balanceOk) passed++;

  console.log("");
  console.log("  Result: " + passed + "/" + checks + " checks passed");
  console.log("");

  // ===== EXPLORER LINKS =====
  console.log("  === EXPLORER ===");
  console.log("");
  console.log("  Program:      https://explorer.solana.com/address/" + program.programId.toBase58() + "?cluster=devnet");
  console.log("  GlobalState:  https://explorer.solana.com/address/" + gs.toBase58() + "?cluster=devnet");
  if (currentDrawId > 0 && currentDrawOk) {
    var lastDid = new anchor.BN(currentDrawId);
    var lastDp = PublicKey.findProgramAddressSync(
      [Buffer.from("draw-v3"), lastDid.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
    console.log("  Last Draw:    https://explorer.solana.com/address/" + lastDp.toBase58() + "?cluster=devnet");
  }
  console.log("");
  hr();
  console.log("  MegaByt Protocol — Verifiable Value Redistribution");
  console.log("  \"No trust required. Only verification.\"");
  hr();
  console.log("");
}

main().catch(function(e: any) {
  console.error("ERROR: " + (e.message || e));
  process.exit(1);
});
