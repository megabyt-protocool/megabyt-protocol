import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

(async function() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = (anchor.workspace as any).Megabyt;
  var wallet = (provider.wallet as any).payer || provider.wallet;

  var drawPda = new PublicKey("EwMdzD41EJfaag7VpyPRHvUBZihuXCC7qq8CuSp28tU6");
  var globalState = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");

  console.log("=== RESET + RE-SETTLE DRAW 6 ===");
  console.log("Draw:        " + drawPda.toBase58());
  console.log("GlobalState: " + globalState.toBase58());
  console.log("");

  // Step 1: Read current state
  var before = await program.account.draw.fetch(drawPda);
  console.log("BEFORE RESET:");
  console.log("  status:              " + before.status);
  console.log("  tickets_sold:        " + (before.ticketsSold || before.tickets_sold));
  console.log("  tickets_processed:   " + (before.ticketsProcessed || before.tickets_processed));
  console.log("  settlement_complete: " + (before.settlementComplete || before.settlement_complete));
  console.log("  winner_counts:       " + String(before.winnerCounts || before.winner_counts));
  console.log("");

  // Step 2: Reset settlement
  console.log("Calling resetDrawSettlement...");
  try {
    var txReset = await (program.methods.resetDrawSettlement().accounts as any)({
      admin: provider.wallet.publicKey,
      globalState: globalState,
      draw: drawPda
    }).rpc();

    var bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      { signature: txReset, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      "confirmed"
    );
    console.log("Reset TX: " + txReset);
  } catch (e: any) {
    console.error("Reset failed: " + (e.message || e));
    if (e.logs) {
      for (var li = 0; li < e.logs.length; li++) {
        console.error("  " + e.logs[li]);
      }
    }
    process.exit(1);
  }

  var afterReset = await program.account.draw.fetch(drawPda);
  console.log("");
  console.log("AFTER RESET:");
  console.log("  status:              " + afterReset.status);
  console.log("  tickets_processed:   " + (afterReset.ticketsProcessed || afterReset.tickets_processed));
  console.log("  winner_counts:       " + String(afterReset.winnerCounts || afterReset.winner_counts));
  console.log("");

  // Step 3: Re-settle in batches of 20
  console.log("Fetching tickets...");
  var allTickets = await program.account.ticket.all();
  var pending: Array<{ publicKey: PublicKey }> = [];

  for (var i = 0; i < allTickets.length; i++) {
    try {
      var t = allTickets[i];
      if (!t || !t.account) continue;
      var dk = t.account.draw || t.account.drawState || t.account.draw_state;
      var pk = t.publicKey || t.pubkey;
      if (!dk || !pk || typeof dk.toBase58 !== "function") continue;
      if (dk.toBase58() !== drawPda.toBase58()) continue;
      if (t.account.settled) continue;
      pending.push({ publicKey: pk });
    } catch (e) { continue; }
  }

  console.log("Unsettled tickets: " + pending.length);
  var BATCH = 20;
  var totalBatches = Math.ceil(pending.length / BATCH);
  console.log("Batches: " + totalBatches);
  console.log("");

  var offset = 0;
  var batchNum = 0;

  while (offset < pending.length) {
    batchNum++;
    var end = Math.min(offset + BATCH, pending.length);
    var slice = pending.slice(offset, end);

    var remaining: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> = [];
    for (var j = 0; j < slice.length; j++) {
      remaining.push({ pubkey: slice[j].publicKey, isWritable: true, isSigner: false });
    }

    console.log("Batch " + batchNum + "/" + totalBatches + " | " + remaining.length + " tickets");

    try {
      var txS = await (program.methods.settleTickets(remaining.length) as any)
        .accounts({ draw: drawPda })
        .remainingAccounts(remaining)
        .rpc();

      var bh2 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction(
        { signature: txS, blockhash: bh2.blockhash, lastValidBlockHeight: bh2.lastValidBlockHeight },
        "confirmed"
      );

      console.log("  TX: " + txS);
      var mid = await program.account.draw.fetch(drawPda);
      console.log("  processed: " + (mid.ticketsProcessed || mid.tickets_processed) + " | status: " + mid.status);
    } catch (e: any) {
      console.error("  ERROR: " + (e.message || e));
      if (e.logs) {
        for (var el = 0; el < e.logs.length; el++) {
          console.error("    " + e.logs[el]);
        }
      }
    }

    offset = end;
    await new Promise(function(r) { setTimeout(r, 500); });
  }

  // Final state
  console.log("");
  console.log("========================================");
  console.log("  DRAW 6 - FINAL STATE AFTER RE-SETTLE");
  console.log("========================================");
  var final1 = await program.account.draw.fetch(drawPda);
  console.log("  status:              " + final1.status);
  console.log("  tickets_sold:        " + (final1.ticketsSold || final1.tickets_sold));
  console.log("  tickets_processed:   " + (final1.ticketsProcessed || final1.tickets_processed));
  console.log("  settlement_complete: " + (final1.settlementComplete || final1.settlement_complete));
  console.log("  settled:             " + final1.settled);
  console.log("  winner_counts:       " + String(final1.winnerCounts || final1.winner_counts));
  console.log("");

  // Verify tickets
  console.log("Verifying tickets...");
  var all2 = await program.account.ticket.all();
  var settledCount = 0;
  var tierDist: Record<string, number> = {};
  for (var v = 0; v < all2.length; v++) {
    try {
      var vt = all2[v];
      if (!vt || !vt.account) continue;
      var vdk = vt.account.draw || vt.account.drawState || vt.account.draw_state;
      if (!vdk || typeof vdk.toBase58 !== "function") continue;
      if (vdk.toBase58() !== drawPda.toBase58()) continue;
      if (vt.account.settled) settledCount++;
      var vtier = String(vt.account.tier);
      if (!tierDist[vtier]) tierDist[vtier] = 0;
      tierDist[vtier]++;
    } catch (e) { continue; }
  }
  console.log("  Tickets settled on-chain: " + settledCount + "/267");
  console.log("  Tier distribution:");
  var tkeys = Object.keys(tierDist).sort();
  for (var tk = 0; tk < tkeys.length; tk++) {
    var lab = tkeys[tk] === "255" ? "no-prize" : "tier-" + tkeys[tk];
    console.log("    " + lab + ": " + tierDist[tkeys[tk]]);
  }
  console.log("");
  console.log("Done.");
})();
