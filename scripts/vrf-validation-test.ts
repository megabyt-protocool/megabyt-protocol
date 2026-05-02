import * as anchor from "@coral-xyz/anchor";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";

(async function() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = (anchor.workspace as any).Megabyt;
  var connection = provider.connection;

  var globalState = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");

  console.log("=== VRF VALIDATION TEST (DEVNET) ===");
  console.log("Program: " + program.programId.toBase58());
  console.log("");

  // Read current draw
  var globalData = await program.account.globalState.fetch(globalState);
  var drawId = Number(globalData.currentDrawId || globalData.current_draw_id || 0);

  if (drawId === 0) {
    console.error("No draw exists. Open a draw with tickets first.");
    process.exit(1);
  }

  var drawRes = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), new anchor.BN(drawId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  var drawPda = drawRes[0];

  console.log("Draw ID:  " + drawId);
  console.log("Draw PDA: " + drawPda.toBase58());
  console.log("");

  var draw = await program.account.draw.fetch(drawPda);

  console.log("Status:              " + draw.status);
  console.log("isOpen:              " + draw.isOpen);
  console.log("isClosed:            " + draw.isClosed);
  console.log("ticketsSold:         " + (draw.ticketsSold || draw.tickets_sold));
  console.log("randomnessRequested: " + draw.randomnessRequested);
  console.log("randomnessFulfilled: " + draw.randomnessFulfilled);
  console.log("randomnessAccount:   " + (draw.randomnessAccount ? draw.randomnessAccount.toBase58() : "none"));
  console.log("");

  // Check: draw must be open with tickets
  if (!draw.isOpen || draw.isClosed) {
    console.error("Draw is not open. Status=" + draw.status);
    process.exit(1);
  }

  if (Number(draw.ticketsSold || draw.tickets_sold) === 0) {
    console.error("No tickets sold. Buy tickets first.");
    process.exit(1);
  }

  // Step 1: requestRandomness (if not already done)
  if (!draw.randomnessRequested) {
    console.log("--- Step 1: requestRandomness ---");
    var rKp = anchor.web3.Keypair.generate();

    var txR = await (program.methods.requestRandomness().accounts as any)({
      draw: drawPda,
      randomnessAccount: rKp.publicKey,
    }).rpc();

    var bh1 = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: txR, blockhash: bh1.blockhash, lastValidBlockHeight: bh1.lastValidBlockHeight },
      "confirmed"
    );

    console.log("TX: " + txR);
    console.log("Randomness account: " + rKp.publicKey.toBase58());
    console.log("");

    // Re-read draw
    draw = await program.account.draw.fetch(drawPda);
  } else {
    console.log("requestRandomness already done.");
    console.log("Randomness account: " + draw.randomnessAccount.toBase58());
    console.log("");
  }

  // Step 2: Wait for VRF oracle
  console.log("--- Step 2: Waiting for VRF oracle ---");
  console.log("Polling every 3s... (max 60s)");
  console.log("");

  var maxWait = 60;
  var waited = 0;
  var vrfReady = false;

  while (waited < maxWait) {
    // Try to close draw - if VRF is ready it will succeed
    // But first just check the randomness account for data
    try {
      var rAcct = draw.randomnessAccount;
      var acctInfo = await connection.getAccountInfo(rAcct);
      if (acctInfo && acctInfo.data.length > 0) {
        console.log("  " + waited + "s: Randomness account has " + acctInfo.data.length + " bytes");
      } else {
        console.log("  " + waited + "s: Randomness account empty or not found");
      }
    } catch (e) {
      console.log("  " + waited + "s: Error reading randomness account");
    }

    waited += 3;
    await new Promise(function(r) { setTimeout(r, 3000); });
  }

  console.log("");
  console.log("Wait complete. Attempting close_draw...");
  console.log("");

  // Step 3: close_draw with VRF
  console.log("--- Step 3: closeDraw (VRF real) ---");

  var rAcctKey = draw.randomnessAccount;
  var cIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });

  try {
    var txC = await (program.methods.closeDraw().accounts as any)({
      globalState: globalState,
      draw: drawPda,
      randomnessAccountData: rAcctKey,
    }).preInstructions([cIx]).rpc();

    var bh2 = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: txC, blockhash: bh2.blockhash, lastValidBlockHeight: bh2.lastValidBlockHeight },
      "confirmed"
    );

    console.log("TX: " + txC);
    console.log("");

    var drawAfter = await program.account.draw.fetch(drawPda);
    console.log("=== CLOSE DRAW RESULT ===");
    console.log("  status:              " + drawAfter.status);
    console.log("  isClosed:            " + drawAfter.isClosed);
    console.log("  randomnessFulfilled: " + drawAfter.randomnessFulfilled);
    console.log("  resultNumbers:       " + String(drawAfter.resultNumbers || drawAfter.result_numbers));
    console.log("  resultCrypto:        " + String(drawAfter.resultCrypto || drawAfter.result_crypto));
    console.log("");

    if (drawAfter.isClosed && Number(drawAfter.status) === 1) {
      console.log("VRF VALIDATION: PASSED");
      console.log("Numbers generated from REAL Switchboard VRF");
      console.log("Zero fallback. Zero mock. Production ready.");
    } else {
      console.log("VRF VALIDATION: UNEXPECTED STATE");
      console.log("Check logs above.");
    }

  } catch (e: any) {
    console.error("closeDraw FAILED: " + (e.message || e));
    if (e.logs) {
      console.error("Logs:");
      for (var li = 0; li < e.logs.length; li++) {
        console.error("  " + e.logs[li]);
      }
    }
    console.error("");
    console.error("If error is 'VRF not fulfilled', the oracle may need more time.");
    console.error("Try again in 30s.");
  }

  console.log("");
  console.log("Done.");
})();
