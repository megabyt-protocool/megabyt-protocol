/**
 * MegaByt Protocol — check-1000-budget.ts
 * Pre-flight budget check for 1000-ticket stress test
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/check-1000-budget.ts
 *
 * Env (optional):
 *   TICKETS   - target ticket count (default 1000)
 *   MULTI     - tickets per user (default 5)
 */

var anchor = require("@coral-xyz/anchor");
var { PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
var { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } = require("@solana/spl-token");
var IDL = require("../target/idl/megabyt.json");

var TICKETS = parseInt(process.env.TICKETS || "1000", 10);
var MULTI = parseInt(process.env.MULTI || "5", 10);

function pick(o: any, a: string, b: string) {
  return o[a] !== undefined && o[a] !== null ? o[a] : (o[b] !== undefined && o[b] !== null ? o[b] : null);
}

function hr() { console.log("================================================================"); }

async function detectTP(conn: any, mint: any) {
  var info = await conn.getAccountInfo(mint);
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function main() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = new anchor.Program(IDL, provider);
  var wallet = (provider.wallet as any).payer;
  var conn = provider.connection;

  var usersNeeded = Math.ceil(TICKETS / MULTI);

  console.log("");
  hr();
  console.log("  MEGABYT — PRE-FLIGHT BUDGET CHECK");
  console.log("  Target: " + TICKETS + " tickets (" + usersNeeded + " wallets x " + MULTI + "/user)");
  hr();
  console.log("");

  // ===== READ ON-CHAIN STATE =====
  var gs = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")], program.programId
  )[0];

  var gd: any;
  try {
    gd = await program.account.globalState.fetch(gs);
  } catch (e) {
    console.error("  ERROR: Cannot read GlobalState. Is the program deployed?");
    console.error("  GlobalState PDA: " + gs.toBase58());
    process.exit(1);
  }

  var pv = pick(gd, "prizeVault", "prize_vault");
  var vi = await getAccount(conn, pv);
  var MINT = vi.mint;
  var TP = await detectTP(conn, MINT);
  var ticketPrice = Number(pick(gd, "ticketPrice", "ticket_price"));
  var currentDrawId = Number(pick(gd, "currentDrawId", "current_draw_id") || 0);

  // ===== WALLET BALANCES =====
  var adminSolLamports = await conn.getBalance(wallet.publicKey);
  var adminSol = adminSolLamports / LAMPORTS_PER_SOL;

  var adminAta = getAssociatedTokenAddressSync(MINT, wallet.publicKey, false, TP);
  var adminTokenBalance = 0;
  try {
    var ataInfo = await getAccount(conn, adminAta, "confirmed", TP);
    adminTokenBalance = Number(ataInfo.amount);
  } catch (e) {
    // ATA doesn't exist yet
  }

  console.log("  === WALLET ===");
  console.log("  Address:          " + wallet.publicKey.toBase58());
  console.log("  SOL balance:      " + adminSol.toFixed(4) + " SOL");
  console.log("  Token balance:    " + adminTokenBalance);
  console.log("  Token mint:       " + MINT.toBase58());
  console.log("  Ticket price:     " + ticketPrice);
  console.log("  Current draw ID:  " + currentDrawId);
  console.log("");

  // ===== COST ESTIMATION =====
  // Based on real data: 200 tickets = 2.0157 SOL = 0.0101 SOL/ticket
  // With MULTI=5: each wallet needs ATA creation + SOL funding
  // ATA rent: ~0.00204 SOL, tx fees: ~0.000005 each

  var SOL_PER_ATA_CREATION = 0.00204;           // rent exempt minimum
  var SOL_FUNDING_PER_WALLET = 0.015 * MULTI;   // SOL to fund each user wallet
  var TX_FEE = 0.000005;                        // base tx fee
  var SETTLE_BATCHES = Math.ceil(TICKETS / 20);  // 20 tickets per settle batch

  // Costs breakdown
  var costFundingSol = usersNeeded * SOL_FUNDING_PER_WALLET;
  var costAtaCreation = usersNeeded * SOL_PER_ATA_CREATION;
  var costTokenTransfers = usersNeeded * TX_FEE;
  var costBuyTxFees = TICKETS * TX_FEE;
  var costSettleFees = SETTLE_BATCHES * TX_FEE;
  var costFinalizeFees = TX_FEE * 3;  // finalize + close + request_randomness
  var costPayFees = TICKETS * TX_FEE * 0.3;  // ~30% are winners on average

  var costSolBase = costFundingSol + costAtaCreation + costTokenTransfers
    + costBuyTxFees + costSettleFees + costFinalizeFees + costPayFees;

  var costTokenNeeded = TICKETS * ticketPrice;

  // Margins
  var MARGIN_MINIMUM = 1.2;    // 20% margin
  var MARGIN_IDEAL = 1.35;     // 35% margin

  var solMinimum = costSolBase * MARGIN_MINIMUM;
  var solIdeal = costSolBase * MARGIN_IDEAL;

  // Clamp to at least known good estimates
  if (solMinimum < 12) solMinimum = 12;
  if (solIdeal < 15) solIdeal = 15;

  console.log("  === COST ESTIMATION (" + TICKETS + " tickets) ===");
  console.log("");
  console.log("  SOL funding (" + usersNeeded + " wallets):     " + costFundingSol.toFixed(4) + " SOL");
  console.log("  ATA creation (" + usersNeeded + " ATAs):       " + costAtaCreation.toFixed(4) + " SOL");
  console.log("  Token transfer fees:          " + costTokenTransfers.toFixed(4) + " SOL");
  console.log("  Buy ticket tx fees:           " + costBuyTxFees.toFixed(4) + " SOL");
  console.log("  Settle batch fees:            " + costSettleFees.toFixed(4) + " SOL");
  console.log("  Finalize/close fees:          " + costFinalizeFees.toFixed(6) + " SOL");
  console.log("  Pay winners fees (est):       " + costPayFees.toFixed(4) + " SOL");
  console.log("  -----------------------------------------");
  console.log("  Base estimated cost:          " + costSolBase.toFixed(4) + " SOL");
  console.log("  Minimum recommended (+20%):   " + solMinimum.toFixed(2) + " SOL");
  console.log("  Ideal recommended (+35%):     " + solIdeal.toFixed(2) + " SOL");
  console.log("");
  console.log("  Token needed:                 " + costTokenNeeded);
  console.log("");

  // ===== VERDICT =====
  var solOk = adminSol >= solMinimum;
  var tokenOk = adminTokenBalance >= costTokenNeeded;
  var solIdealOk = adminSol >= solIdeal;

  console.log("  === VERDICT ===");
  console.log("");

  if (solOk && tokenOk) {
    if (solIdealOk) {
      console.log("  ✅ READY — Ideal conditions met");
      console.log("");
      console.log("  SOL:   " + adminSol.toFixed(4) + " >= " + solIdeal.toFixed(2) + " (ideal)     ✅");
      console.log("  Token: " + adminTokenBalance + " >= " + costTokenNeeded + "     ✅");
    } else {
      console.log("  ⚠️  READY (TIGHT) — Minimum met, but below ideal");
      console.log("");
      console.log("  SOL:   " + adminSol.toFixed(4) + " >= " + solMinimum.toFixed(2) + " (min)      ✅");
      console.log("  SOL:   " + adminSol.toFixed(4) + " <  " + solIdeal.toFixed(2) + " (ideal)    ⚠️");
      console.log("  Token: " + adminTokenBalance + " >= " + costTokenNeeded + "     ✅");
      console.log("");
      console.log("  Recommendation: add " + (solIdeal - adminSol).toFixed(2) + " more SOL for safety");
    }
  } else {
    console.log("  ❌ NOT READY");
    console.log("");

    if (!solOk) {
      var solShort = solMinimum - adminSol;
      console.log("  SOL:   " + adminSol.toFixed(4) + " < " + solMinimum.toFixed(2) + " (minimum)  ❌");
      console.log("         Need " + solShort.toFixed(2) + " more SOL");
      console.log("         Run: solana airdrop 2 (repeat " + Math.ceil(solShort / 2) + " times)");
      console.log("         Or:  solana airdrop 5 --url devnet (if available)");
    } else {
      console.log("  SOL:   " + adminSol.toFixed(4) + " >= " + solMinimum.toFixed(2) + "           ✅");
    }

    if (!tokenOk) {
      var tokenShort = costTokenNeeded - adminTokenBalance;
      console.log("  Token: " + adminTokenBalance + " < " + costTokenNeeded + "           ❌");
      console.log("         Need " + tokenShort + " more tokens");
      console.log("         Run: spl-token mint " + MINT.toBase58() + " " + tokenShort);
    } else {
      console.log("  Token: " + adminTokenBalance + " >= " + costTokenNeeded + "     ✅");
    }
  }

  console.log("");
  console.log("  === EXECUTION PLAN ===");
  console.log("");
  console.log("  Strategy:        " + usersNeeded + " wallets x " + MULTI + " tickets/wallet");
  console.log("  Batch size:      10 wallets/batch (fund + buy)");
  console.log("  Settle batches:  " + SETTLE_BATCHES + " (20 tickets/batch)");
  console.log("  Checkpoint:      Every 10 wallets");
  console.log("  Resume support:  Yes (auto-detects checkpoint file)");
  console.log("  Retry policy:    3 attempts, exponential backoff (2s/4s/8s)");
  console.log("");
  console.log("  To run:");
  console.log("    npx ts-node --transpile-only scripts/flow-1000-devnet.ts");
  console.log("");
  console.log("  To resume after interruption:");
  console.log("    npx ts-node --transpile-only scripts/flow-1000-devnet.ts");
  console.log("    (auto-detects checkpoint file and continues)");
  console.log("");
  hr();
}

main().catch(function(e: any) {
  console.error("ERROR: " + (e.message || e));
  process.exit(1);
});
