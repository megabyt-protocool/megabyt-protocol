import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

(async function() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = (anchor.workspace as any).Megabyt;

  var drawPda = new PublicKey("EwMdzD41EJfaag7VpyPRHvUBZihuXCC7qq8CuSp28tU6");
  var globalState = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");

  console.log("=== FINALIZE PAYOUTS - DRAW 6 ===");
  console.log("Draw: " + drawPda.toBase58());
  console.log("");

  var before = await program.account.draw.fetch(drawPda);
  console.log("BEFORE:");
  console.log("  status:              " + before.status);
  console.log("  tickets_sold:        " + (before.ticketsSold || before.tickets_sold));
  console.log("  tickets_processed:   " + (before.ticketsProcessed || before.tickets_processed));
  console.log("  settlement_complete: " + (before.settlementComplete || before.settlement_complete));
  console.log("  settled:             " + before.settled);
  console.log("  winner_counts:       " + String(before.winnerCounts || before.winner_counts));
  console.log("  prize_per_tier:      " + String(before.prizePerTier || before.prize_per_tier));
  console.log("");

  if (before.status !== 2) {
    console.error("  Draw status is " + before.status + ", expected 2. Aborting.");
    process.exit(1);
  }

  console.log("Calling finalizePayouts...");
  try {
    var tx = await (program.methods.finalizePayouts().accounts as any)({
      globalState: globalState,
      draw: drawPda
    }).rpc();

    var bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      { signature: tx, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      "confirmed"
    );
    console.log("TX: " + tx);
  } catch (e: any) {
    console.error("Finalize failed: " + (e.message || e));
    if (e.logs) {
      console.error("Logs:");
      for (var i = 0; i < e.logs.length; i++) {
        console.error("  " + e.logs[i]);
      }
    }
    process.exit(1);
  }

  console.log("");
  var after = await program.account.draw.fetch(drawPda);
  console.log("AFTER FINALIZE:");
  console.log("  status:              " + after.status);
  console.log("  winner_counts:       " + String(after.winnerCounts || after.winner_counts));
  console.log("  prize_per_tier:      " + String(after.prizePerTier || after.prize_per_tier));
  console.log("  settlement_complete: " + (after.settlementComplete || after.settlement_complete));
  console.log("  settled:             " + after.settled);
  console.log("");

  // Calculate total distributed
  var ppt = after.prizePerTier || after.prize_per_tier || [];
  var wc = after.winnerCounts || after.winner_counts || [];
  var totalDistributed = 0;
  console.log("Prize breakdown:");
  for (var t = 0; t < 10; t++) {
    var winners = Number(wc[t] || 0);
    var prizeEach = Number(ppt[t] || 0);
    var tierTotal = winners * prizeEach;
    if (winners > 0) {
      console.log("  Tier " + t + ": " + winners + " winners x " + prizeEach + " = " + tierTotal);
    }
    totalDistributed += tierTotal;
  }
  console.log("");
  console.log("  Total to distribute: " + totalDistributed);
  console.log("");
  console.log("Done. Ready for pay_winners_batch.");
})();
