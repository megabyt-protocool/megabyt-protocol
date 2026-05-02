import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

(async function() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = (anchor.workspace as any).Megabyt;

  var drawPda = new PublicKey("EwMdzD41EJfaag7VpyPRHvUBZihuXCC7qq8CuSp28tU6");
  var BATCH_SIZE = 20;

  console.log("Program: " + program.programId.toBase58());
  console.log("Draw:    " + drawPda.toBase58());
  console.log("Batch:   " + BATCH_SIZE);
  console.log("");

  var drawData = await program.account.draw.fetch(drawPda);
  console.log("Draw status:            " + drawData.status);
  console.log("Draw tickets_sold:      " + (drawData.ticketsSold || drawData.tickets_sold));
  console.log("Draw tickets_processed: " + (drawData.ticketsProcessed || drawData.tickets_processed));
  console.log("Draw settled:           " + drawData.settled);
  console.log("");

  console.log("Fetching all tickets...");
  var allTickets = await program.account.ticket.all();
  console.log("Total tickets on-chain: " + allTickets.length);

  var pending: Array<{ publicKey: PublicKey; account: any }> = [];
  for (var i = 0; i < allTickets.length; i++) {
    try {
      var t = allTickets[i];
      if (!t || !t.account) continue;
      var dk = t.account.draw || t.account.drawState || t.account.draw_state;
      var pk = t.publicKey || t.pubkey;
      if (!dk || !pk || typeof dk.toBase58 !== "function") continue;
      if (dk.toBase58() !== drawPda.toBase58()) continue;
      if (t.account.settled) continue;
      pending.push({ publicKey: pk, account: t.account });
    } catch (e) {
      continue;
    }
  }

  console.log("Unsettled tickets:      " + pending.length);
  console.log("");

  if (pending.length === 0) {
    console.log("All tickets already settled. Nothing to do.");
    var final0 = await program.account.draw.fetch(drawPda);
    console.log("  status:              " + final0.status);
    console.log("  tickets_processed:   " + (final0.ticketsProcessed || final0.tickets_processed));
    console.log("  settlement_complete: " + (final0.settlementComplete || final0.settlement_complete));
    console.log("  winner_counts:       " + String(final0.winnerCounts || final0.winner_counts));
    process.exit(0);
  }

  var totalBatches = Math.ceil(pending.length / BATCH_SIZE);
  console.log("Total batches: " + totalBatches);
  console.log("");

  var batchNum = 0;
  var offset = 0;

  while (offset < pending.length) {
    batchNum++;
    var end = Math.min(offset + BATCH_SIZE, pending.length);
    var batch = pending.slice(offset, end);

    var remaining: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> = [];
    for (var j = 0; j < batch.length; j++) {
      remaining.push({
        pubkey: batch[j].publicKey,
        isWritable: true,
        isSigner: false
      });
    }

    console.log("Batch " + batchNum + "/" + totalBatches + " | tickets: " + remaining.length + " | offset: " + offset);

    try {
      var tx = await (program.methods.settleTickets(remaining.length) as any)
        .accounts({ draw: drawPda })
        .remainingAccounts(remaining)
        .rpc();

      var bh = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction(
        { signature: tx, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
        "confirmed"
      );

      console.log("  TX: " + tx);

      var mid = await program.account.draw.fetch(drawPda);
      console.log("  tickets_processed: " + (mid.ticketsProcessed || mid.tickets_processed));
      console.log("  status:            " + mid.status);
      console.log("");
    } catch (e: any) {
      console.error("  ERROR in batch " + batchNum + ": " + (e.message || e));
      if (e.logs) {
        for (var li = 0; li < e.logs.length; li++) {
          console.error("    " + e.logs[li]);
        }
      }
      console.error("");
    }

    offset = end;
    await new Promise(function(r) { setTimeout(r, 500); });
  }

  console.log("========================================");
  console.log("  SETTLE DRAW 6 - FINAL STATE");
  console.log("========================================");
  console.log("");
  var final1 = await program.account.draw.fetch(drawPda);
  console.log("  status:              " + final1.status);
  console.log("  tickets_sold:        " + (final1.ticketsSold || final1.tickets_sold));
  console.log("  tickets_processed:   " + (final1.ticketsProcessed || final1.tickets_processed));
  console.log("  settlement_complete: " + (final1.settlementComplete || final1.settlement_complete));
  console.log("  settled:             " + final1.settled);
  console.log("  winner_counts:       " + String(final1.winnerCounts || final1.winner_counts));
  console.log("  result_numbers:      " + String(final1.resultNumbers || final1.result_numbers));
  console.log("  result_crypto:       " + String(final1.resultCrypto || final1.result_crypto));
  console.log("");
  console.log("Done.");
})();
