import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount
} from "@solana/spl-token";

(async function() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = (anchor.workspace as any).Megabyt;
  var connection = provider.connection;

  var drawPda = new PublicKey("EwMdzD41EJfaag7VpyPRHvUBZihuXCC7qq8CuSp28tU6");
  var globalState = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");
  var vaultAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority-v3")], program.programId
  )[0];

  console.log("=== PAY WINNERS - DRAW 6 ===");
  console.log("Draw:           " + drawPda.toBase58());
  console.log("GlobalState:    " + globalState.toBase58());
  console.log("VaultAuthority: " + vaultAuthority.toBase58());
  console.log("");

  // Read global state for prize vault
  var globalData = await program.account.globalState.fetch(globalState);
  var prizeVault = globalData.prizeVault || globalData.prize_vault;
  if (!prizeVault) {
    console.error("  prize_vault is null.");
    process.exit(1);
  }

  // Detect mint and token program
  var vaultAcct = await getAccount(connection, prizeVault);
  var THE_MINT = vaultAcct.mint;
  var mintInfo = await connection.getAccountInfo(THE_MINT);
  var TP = TOKEN_PROGRAM_ID;
  if (mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    TP = TOKEN_2022_PROGRAM_ID;
  }

  console.log("PrizeVault:     " + prizeVault.toBase58());
  console.log("Mint:           " + THE_MINT.toBase58());
  console.log("TokenProgram:   " + TP.toBase58());
  console.log("");

  // Read draw state
  var draw = await program.account.draw.fetch(drawPda);
  console.log("DRAW STATE:");
  console.log("  status:         " + draw.status);
  console.log("  winner_counts:  " + String(draw.winnerCounts || draw.winner_counts));
  console.log("  prize_per_tier: " + String(draw.prizePerTier || draw.prize_per_tier));
  console.log("  is_paid:        " + String(draw.isPaid || draw.is_paid || false));
  console.log("");

  if (draw.status !== 3) {
    console.error("  Draw status is " + draw.status + ", expected 3. Run finalize first.");
    process.exit(1);
  }

  if (draw.isPaid || draw.is_paid) {
    console.log("  Draw already fully paid. Nothing to do.");
    process.exit(0);
  }

  // Fetch all tickets for this draw
  console.log("Fetching tickets...");
  var allTickets = await program.account.ticket.all();
  var drawTickets: Array<{ publicKey: PublicKey; account: any }> = [];

  for (var i = 0; i < allTickets.length; i++) {
    try {
      var t = allTickets[i];
      if (!t || !t.account) continue;
      var dk = t.account.draw || t.account.drawState || t.account.draw_state;
      var pk = t.publicKey || t.pubkey;
      if (!dk || !pk || typeof dk.toBase58 !== "function") continue;
      if (dk.toBase58() !== drawPda.toBase58()) continue;
      drawTickets.push({ publicKey: pk, account: t.account });
    } catch (e) { continue; }
  }

  console.log("Total tickets for Draw 6: " + drawTickets.length);

  // Filter: winners (tier 0-9) that are not paid
  var winners: Array<{ publicKey: PublicKey; account: any }> = [];
  var alreadyPaid = 0;
  var nonWinners = 0;

  for (var j = 0; j < drawTickets.length; j++) {
    var a = drawTickets[j].account;
    var tier = a.tier;
    if (tier === undefined || tier === null) tier = 255;
    if (tier > 9) {
      nonWinners++;
      continue;
    }
    if (a.paid || a.isPaid || a.is_paid) {
      alreadyPaid++;
      continue;
    }
    winners.push(drawTickets[j]);
  }

  console.log("Winners unpaid:  " + winners.length);
  console.log("Already paid:    " + alreadyPaid);
  console.log("Non-winners:     " + nonWinners);
  console.log("");

  if (winners.length === 0) {
    console.log("No unpaid winners found.");
    // Still call payWinnersBatch once for fast-path (marks is_paid=true if zero winners)
    if (drawTickets.length > 0) {
      var ft = drawTickets[0];
      var ftOwner = ft.account.owner || ft.account.user || ft.account.buyer || ft.account.player;
      if (ftOwner && typeof ftOwner.toBase58 === "function") {
        var ftAta = getAssociatedTokenAddressSync(THE_MINT, ftOwner, false, TP);
        console.log("Calling payWinnersBatch fast-path...");
        try {
          var txFp = await (program.methods.payWinnersBatch(1).accounts as any)({
            draw: drawPda,
            ticket: ft.publicKey,
            globalState: globalState,
            prizeVault: prizeVault,
            userTokenAccount: ftAta,
            vaultAuthority: vaultAuthority,
            tokenProgram: TP
          }).rpc();
          var bh0 = await connection.getLatestBlockhash();
          await connection.confirmTransaction(
            { signature: txFp, blockhash: bh0.blockhash, lastValidBlockHeight: bh0.lastValidBlockHeight },
            "confirmed"
          );
          console.log("Fast-path TX: " + txFp);
        } catch (e: any) {
          console.log("Fast-path result: " + (e.message || "").slice(0, 100));
        }
      }
    }
  } else {
    // Pay each winner
    var paidCount = 0;
    var failCount = 0;

    for (var w = 0; w < winners.length; w++) {
      var wt = winners[w];
      var wtOwner = wt.account.owner || wt.account.user || wt.account.buyer || wt.account.player;

      if (!wtOwner || typeof wtOwner.toBase58 !== "function") {
        console.log("  Ticket " + (w + 1) + ": cannot resolve owner. Skipping.");
        failCount++;
        continue;
      }

      var wtAta = getAssociatedTokenAddressSync(THE_MINT, wtOwner, false, TP);

      console.log("  Paying " + (w + 1) + "/" + winners.length +
        " | tier=" + wt.account.tier +
        " | ticket=" + wt.publicKey.toBase58().slice(0, 12) +
        " | owner=" + wtOwner.toBase58().slice(0, 12) +
        " | ata=" + wtAta.toBase58().slice(0, 12));

      try {
        var txPay = await (program.methods.payWinnersBatch(1).accounts as any)({
          draw: drawPda,
          ticket: wt.publicKey,
          globalState: globalState,
          prizeVault: prizeVault,
          userTokenAccount: wtAta,
          vaultAuthority: vaultAuthority,
          tokenProgram: TP
        }).rpc();

        var bhPay = await connection.getLatestBlockhash();
        await connection.confirmTransaction(
          { signature: txPay, blockhash: bhPay.blockhash, lastValidBlockHeight: bhPay.lastValidBlockHeight },
          "confirmed"
        );

        paidCount++;
        console.log("    TX: " + txPay);
      } catch (e: any) {
        var em = e.message || "";
        if (em.indexOf("AlreadyPaid") !== -1 || em.indexOf("already paid") !== -1) {
          console.log("    Already paid (idempotent skip)");
          alreadyPaid++;
        } else if (em.indexOf("NotAWinner") !== -1) {
          console.log("    Not a winner (skip)");
        } else {
          console.log("    ERROR: " + em.slice(0, 100));
          if (e.logs) {
            for (var el = 0; el < Math.min(5, e.logs.length); el++) {
              console.log("      " + e.logs[el]);
            }
          }
          failCount++;
        }
      }

      // Small delay between txs
      await new Promise(function(r) { setTimeout(r, 300); });
    }

    console.log("");
    console.log("=== PAY SUMMARY ===");
    console.log("  Paid this run:    " + paidCount);
    console.log("  Already paid:     " + alreadyPaid);
    console.log("  Failed:           " + failCount);
    console.log("  Total winners:    " + winners.length);
  }

  // Final state
  console.log("");
  var final1 = await program.account.draw.fetch(drawPda);
  console.log("=== DRAW 6 FINAL STATE ===");
  console.log("  status:         " + final1.status);
  console.log("  is_paid:        " + String(final1.isPaid || final1.is_paid || false));
  console.log("  winner_counts:  " + String(final1.winnerCounts || final1.winner_counts));
  console.log("  prize_per_tier: " + String(final1.prizePerTier || final1.prize_per_tier));
  console.log("");

  // Verify paid tickets on-chain
  console.log("Verifying paid tickets on-chain...");
  var all2 = await program.account.ticket.all();
  var paidOnChain = 0;
  var winnersOnChain = 0;
  for (var v = 0; v < all2.length; v++) {
    try {
      var vt = all2[v];
      if (!vt || !vt.account) continue;
      var vdk = vt.account.draw || vt.account.drawState || vt.account.draw_state;
      if (!vdk || typeof vdk.toBase58 !== "function") continue;
      if (vdk.toBase58() !== drawPda.toBase58()) continue;
      if (vt.account.tier <= 9) winnersOnChain++;
      if (vt.account.paid || vt.account.isPaid || vt.account.is_paid) paidOnChain++;
    } catch (e) { continue; }
  }
  console.log("  Winners on-chain:  " + winnersOnChain);
  console.log("  Paid on-chain:     " + paidOnChain);
  console.log("");
  console.log("Done.");
})();
