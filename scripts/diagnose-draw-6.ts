import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

(async function() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = (anchor.workspace as any).Megabyt;

  var drawPda = new PublicKey("EwMdzD41EJfaag7VpyPRHvUBZihuXCC7qq8CuSp28tU6");

  console.log("=== DRAW 6 TICKET DIAGNOSTIC ===");
  console.log("Draw: " + drawPda.toBase58());
  console.log("");

  // Draw state
  var draw = await program.account.draw.fetch(drawPda);
  console.log("Draw status:            " + draw.status);
  console.log("Draw tickets_sold:      " + (draw.ticketsSold || draw.tickets_sold));
  console.log("Draw tickets_processed: " + (draw.ticketsProcessed || draw.tickets_processed));
  console.log("Draw settlement_complete: " + (draw.settlementComplete || draw.settlement_complete));
  console.log("Draw settled:           " + draw.settled);
  console.log("Draw is_paid:           " + (draw.isPaid || draw.is_paid));
  console.log("Draw result_numbers:    " + String(draw.resultNumbers || draw.result_numbers));
  console.log("Draw result_crypto:     " + String(draw.resultCrypto || draw.result_crypto));
  console.log("Draw winner_counts:     " + String(draw.winnerCounts || draw.winner_counts));
  console.log("Draw prize_per_tier:    " + String(draw.prizePerTier || draw.prize_per_tier));
  console.log("");

  // All tickets
  console.log("Fetching all tickets...");
  var all = await program.account.ticket.all();
  console.log("Total on-chain: " + all.length);

  // Filter draw 6
  var drawTickets: any[] = [];
  for (var i = 0; i < all.length; i++) {
    try {
      var t = all[i];
      if (!t || !t.account) continue;
      var dk = t.account.draw || t.account.drawState || t.account.draw_state;
      if (!dk || typeof dk.toBase58 !== "function") continue;
      if (dk.toBase58() !== drawPda.toBase58()) continue;
      drawTickets.push(t);
    } catch (e) { continue; }
  }

  console.log("Draw 6 tickets: " + drawTickets.length);
  console.log("");

  // Print ALL fields of first 3 tickets
  console.log("=== FIRST 3 TICKETS (RAW FIELDS) ===");
  for (var j = 0; j < Math.min(3, drawTickets.length); j++) {
    var tk = drawTickets[j];
    var pk = tk.publicKey || tk.pubkey;
    console.log("Ticket #" + j + ": " + (pk ? pk.toBase58() : "?"));
    var keys = Object.keys(tk.account);
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var val = tk.account[key];
      if (val && typeof val.toBase58 === "function") {
        console.log("  " + key + ": " + val.toBase58());
      } else if (val && typeof val.toString === "function" && typeof val !== "string") {
        console.log("  " + key + ": " + val.toString());
      } else {
        console.log("  " + key + ": " + String(val));
      }
    }
    console.log("");
  }

  // Classify all tickets
  var settled = 0;
  var unsettled = 0;
  var paid = 0;
  var unpaid = 0;
  var tierCounts: Record<string, number> = {};
  var winnersUnpaid: any[] = [];

  for (var m = 0; m < drawTickets.length; m++) {
    var a = drawTickets[m].account;
    if (a.settled) { settled++; } else { unsettled++; }
    if (a.paid || a.isPaid || a.is_paid) { paid++; } else { unpaid++; }

    var tier = a.tier !== undefined ? a.tier : (a.winTier !== undefined ? a.winTier : (a.win_tier !== undefined ? a.win_tier : 255));
    var tierStr = String(tier);
    if (!tierCounts[tierStr]) tierCounts[tierStr] = 0;
    tierCounts[tierStr]++;

    // Winner = tier 0-9, not paid
    if (tier <= 9 && !a.paid && !a.isPaid && !a.is_paid) {
      winnersUnpaid.push(drawTickets[m]);
    }
  }

  console.log("=== TICKET SUMMARY ===");
  console.log("Settled:   " + settled);
  console.log("Unsettled: " + unsettled);
  console.log("Paid:      " + paid);
  console.log("Unpaid:    " + unpaid);
  console.log("");
  console.log("Tier distribution:");
  var tierKeys = Object.keys(tierCounts).sort();
  for (var ti = 0; ti < tierKeys.length; ti++) {
    var label = tierKeys[ti] === "255" ? "no-prize" : "tier-" + tierKeys[ti];
    console.log("  " + label + ": " + tierCounts[tierKeys[ti]]);
  }
  console.log("");
  console.log("Winners unpaid: " + winnersUnpaid.length);

  // Print first 5 unpaid winners details
  if (winnersUnpaid.length > 0) {
    console.log("");
    console.log("=== FIRST 5 UNPAID WINNERS ===");
    for (var w = 0; w < Math.min(5, winnersUnpaid.length); w++) {
      var wt = winnersUnpaid[w];
      var wpk = wt.publicKey || wt.pubkey;
      var wa = wt.account;
      console.log("Winner #" + w + ": " + (wpk ? wpk.toBase58() : "?"));
      console.log("  tier:          " + (wa.tier !== undefined ? wa.tier : "?"));
      console.log("  settled:       " + wa.settled);
      console.log("  paid:          " + String(wa.paid || wa.isPaid || wa.is_paid || false));
      console.log("  prize_amount:  " + String(wa.prizeAmount || wa.prize_amount || 0));
      console.log("  user/owner:    " + String((wa.user || wa.owner || wa.buyer || wa.player || "?").toBase58 ? (wa.user || wa.owner || wa.buyer || wa.player).toBase58() : "?"));
      console.log("  numbers:       " + String(wa.numbers));
      console.log("  crypto:        " + String(wa.crypto || wa.cryptoNumber || wa.crypto_number));
      console.log("");
    }
  }

  console.log("=== DIAGNOSTIC COMPLETE ===");
})();
