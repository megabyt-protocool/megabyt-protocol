/**
 * MegaByt Protocol - flow-master-e2e-v3.ts
 * Orquestrador puro. Le estado on-chain e avanca a draw atual.
 * NAO abre draw. NAO compra tickets. NAO chama scripts externos.
 * Uso: npx ts-node scripts/flow-master-e2e-v3.ts
 * Env: SKIP_VRF_WAIT=1 (pula sleep de 10s)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount
} from "@solana/spl-token";
var IDL = require("../target/idl/megabyt.json");

var SKIP_VRF_WAIT = process.env.SKIP_VRF_WAIT === "1";

function log(s: string, m: string): void {
  console.log("  [" + s + "] " + m);
}

async function confirmTx(provider: anchor.AnchorProvider, sig: string): Promise<void> {
  var bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function pick(obj: any, k1: string, k2: string): any {
  if (obj[k1] !== undefined && obj[k1] !== null) return obj[k1];
  if (obj[k2] !== undefined && obj[k2] !== null) return obj[k2];
  return null;
}

async function detectTokenProgram(connection: anchor.web3.Connection, mint: PublicKey): Promise<PublicKey> {
  var info = await connection.getAccountInfo(mint);
  if (!info) throw new Error("Mint not found: " + mint.toBase58());
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function fetchTicketsForDraw(
  program: any,
  drawPda: PublicKey
): Promise<Array<{ publicKey: PublicKey; account: any }>> {
  var all = await (program.account as any).ticket.all();
  var filtered: Array<{ publicKey: PublicKey; account: any }> = [];
  var i: number;
  for (i = 0; i < all.length; i++) {
    try {
      var t = all[i];
      if (!t || !t.account) continue;
      var drawKey = t.account.draw || t.account.drawState || t.account.draw_state;
      var pk = t.publicKey || t.pubkey;
      if (pk && drawKey && typeof drawKey.toBase58 === "function" && drawKey.toBase58() === drawPda.toBase58()) {
        filtered.push({ publicKey: pk, account: t.account });
      }
    } catch (_) {
      continue;
    }
  }
  return filtered;
}

function printDraw(label: string, d: any): void {
  log(label, "status:              " + String(d.status));
  log(label, "isOpen:              " + String(pick(d, "isOpen", "is_open") || "?"));
  log(label, "isClosed:            " + String(pick(d, "isClosed", "is_closed") || "?"));
  log(label, "ticketsSold:         " + String(pick(d, "ticketsSold", "tickets_sold") || 0));
  log(label, "ticketsProcessed:    " + String(pick(d, "ticketsProcessed", "tickets_processed") || 0));
  log(label, "settlementComplete:  " + String(pick(d, "settlementComplete", "settlement_complete") || false));
  log(label, "isPaid:              " + String(pick(d, "isPaid", "is_paid") || false));
  log(label, "winnerCounts:        " + String(pick(d, "winnerCounts", "winner_counts") || "[]"));
  log(label, "resultNumbers:       " + String(pick(d, "resultNumbers", "result_numbers") || "?"));
  log(label, "resultCrypto:        " + String(pick(d, "resultCrypto", "result_crypto") || "?"));
  log(label, "randomnessRequested: " + String(pick(d, "randomnessRequested", "randomness_requested") || false));
  log(label, "randomnessFulfilled: " + String(pick(d, "randomnessFulfilled", "randomness_fulfilled") || false));
}

async function main(): Promise<void> {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = new anchor.Program(IDL, provider) as any;
  var wallet = (provider.wallet as anchor.Wallet).payer;
  var connection = provider.connection;

  console.log("");
  console.log("========================================================");
  console.log("  MegaByt Protocol -- Master Orchestrator v3");
  console.log("  Pure state machine. No open. No buy. No externals.");
  console.log("========================================================");
  console.log("");
  console.log("  Program:  " + program.programId.toBase58());
  console.log("  Wallet:   " + wallet.publicKey.toBase58());
  console.log("  Cluster:  " + connection.rpcEndpoint);
  console.log("");

  var gsRes = PublicKey.findProgramAddressSync([Buffer.from("global-state-v3")], program.programId);
  var globalState = gsRes[0];
  var vaRes = PublicKey.findProgramAddressSync([Buffer.from("vault-authority-v3")], program.programId);
  var vaultAuthority = vaRes[0];

  var globalData: any;
  try {
    globalData = await program.account.globalState.fetch(globalState);
  } catch (e) {
    console.error("  global_state not found. Run init first.");
    process.exit(1);
    return;
  }

  var prizeVault: PublicKey = pick(globalData, "prizeVault", "prize_vault");
  if (!prizeVault) { console.error("  prize_vault is null."); process.exit(1); return; }

  var vaultAcct = await getAccount(connection, prizeVault);
  var THE_MINT = vaultAcct.mint;
  var TP = await detectTokenProgram(connection, THE_MINT);
  var currentDrawId = Number(pick(globalData, "currentDrawId", "current_draw_id") || 0);

  log("BOOT", "global_state:    " + globalState.toBase58());
  log("BOOT", "vault_authority: " + vaultAuthority.toBase58());
  log("BOOT", "prize_vault:     " + prizeVault.toBase58());
  log("BOOT", "mint:            " + THE_MINT.toBase58());
  log("BOOT", "token_program:   " + TP.toBase58());
  log("BOOT", "current_draw_id: " + currentDrawId);
  console.log("");

  if (currentDrawId === 0) {
    console.error("  No draw exists. Run open_draw + buy_ticket first.");
    process.exit(1);
    return;
  }

  var drawId = currentDrawId;
  var drawRes = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), new anchor.BN(drawId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  var drawState = drawRes[0];

  log("DRAW", "draw_id:    " + drawId);
  log("DRAW", "draw_state: " + drawState.toBase58());
  console.log("");

  var drawData: any;
  try {
    drawData = await program.account.draw.fetch(drawState);
  } catch (e) {
    console.error("  Draw " + drawId + " not found on-chain.");
    process.exit(1);
    return;
  }

  printDraw("INITIAL", drawData);
  console.log("");

  // Already complete
  if (Number(drawData.status) === 3 && pick(drawData, "isPaid", "is_paid")) {
    log("DONE", "Draw " + drawId + " already complete. Nothing to do.");
    return;
  }

  // State machine
  var maxLoops = 20;
  var loop: number;

  for (loop = 0; loop < maxLoops; loop++) {
    drawData = await program.account.draw.fetch(drawState);
    var status = Number(drawData.status);
    console.log("--- Loop " + (loop + 1) + " | status=" + status + " ---");

    // ===== STATUS 0: Draw is open =====
    if (status === 0) {
      var ticketsSold = Number(pick(drawData, "ticketsSold", "tickets_sold") || 0);
      if (ticketsSold === 0) {
        log("WARN", "Draw aberta sem tickets. Nada a fazer.");
        log("WARN", "Compre tickets primeiro: buy_ticket");
        break;
      }

      var rRequested = Boolean(pick(drawData, "randomnessRequested", "randomness_requested"));
      var rFulfilled = Boolean(pick(drawData, "randomnessFulfilled", "randomness_fulfilled"));
      var randomnessAccount: PublicKey | null = null;

      if (!rRequested) {
        console.log("  >> requestRandomness");
        var newRandom = Keypair.generate();
        var txR = await (program.methods.requestRandomness().accounts as any)({
          draw: drawState,
          randomnessAccount: newRandom.publicKey
        }).rpc();
        await confirmTx(provider, txR);
        randomnessAccount = newRandom.publicKey;
        log("OK", "requestRandomness");
        log("RANDOMNESS", randomnessAccount.toBase58());

        if (!SKIP_VRF_WAIT) {
          log("WAIT", "Sleeping 10s for randomness...");
          await sleep(10000);
        } else {
          log("WAIT", "SKIP_VRF_WAIT=1, sleeping 2s...");
          await sleep(2000);
        }
      } else {
        randomnessAccount = pick(drawData, "randomnessAccount", "randomness_account");
        if (!randomnessAccount) {
          log("ERR", "Randomness account missing from draw state. Cannot close draw.");
          process.exit(1);
          return;
        }
        log("INFO", "Using stored randomness: " + randomnessAccount.toBase58());
        if (!rFulfilled && !SKIP_VRF_WAIT) {
          log("WAIT", "Sleeping 10s for fulfillment...");
          await sleep(10000);
        }
      }

      console.log("  >> closeDraw");
      var cIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });
      var txC = await (program.methods.closeDraw().accounts as any)({
        globalState: globalState,
        draw: drawState,
        randomnessAccountData: randomnessAccount
      }).preInstructions([cIx]).rpc();
      await confirmTx(provider, txC);
      log("OK", "closeDraw");

    // ===== STATUS 1: Closed, needs settlement =====
    } else if (status === 1) {
      console.log("  >> settleTickets (with remainingAccounts)");
      var tickets = await fetchTicketsForDraw(program, drawState);
      var tSold = Number(pick(drawData, "ticketsSold", "tickets_sold") || 0);
      var tProc = Number(pick(drawData, "ticketsProcessed", "tickets_processed") || 0);
      log("INFO", "Tickets on-chain: " + tickets.length + " | sold: " + tSold + " | processed: " + tProc);

      if (tickets.length === 0) {
        log("ERR", "No tickets found via ticket.all(). Cannot settle.");
        process.exit(1);
        return;
      }

      var remAccts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [];
      var rti: number;
      for (rti = 0; rti < tickets.length; rti++) {
        remAccts.push({ pubkey: tickets[rti].publicKey, isSigner: false, isWritable: true });
      }

      var settled = tProc;
      while (settled < tSold) {
        var bs = Math.min(10, tSold - settled);
        var batchRem = remAccts.slice(settled, settled + bs);
        if (batchRem.length === 0) break;
        var txS = await (program.methods.settleTickets(bs).accounts as any)({
          draw: drawState
        }).remainingAccounts(batchRem).rpc();
        await confirmTx(provider, txS);
        settled += bs;
        log("SETTLE", settled + "/" + tSold);
        await sleep(200);
      }

    // ===== STATUS 2: Settled, needs finalize =====
    } else if (status === 2) {
      console.log("  >> finalizePayouts");
      var txF = await (program.methods.finalizePayouts().accounts as any)({
        globalState: globalState,
        draw: drawState
      }).rpc();
      await confirmTx(provider, txF);
      log("OK", "finalizePayouts");

    // ===== STATUS 3: Finalized =====
    } else if (status === 3) {
      var isPaid = Boolean(pick(drawData, "isPaid", "is_paid"));
      if (isPaid) {
        log("DONE", "Draw " + drawId + " complete. status=3, isPaid=true.");
        break;
      }

      console.log("  >> payWinnersBatch");
      var wc: number[] = pick(drawData, "winnerCounts", "winner_counts") || [];
      var totalW = 0;
      var wci: number;
      for (wci = 0; wci < wc.length; wci++) { totalW += wc[wci]; }

      var payTickets = await fetchTicketsForDraw(program, drawState);
      log("INFO", "Winners: " + totalW + " | Tickets: " + payTickets.length);

      if (totalW === 0) {
        if (payTickets.length > 0) {
          var t0 = payTickets[0];
          var t0owner = t0.account.user || t0.account.owner || t0.account.buyer || t0.account.player;
          if (!t0owner || typeof t0owner.toBase58 !== "function") {
            log("WARN", "Cannot resolve ticket owner. Fields: " + Object.keys(t0.account).join(", "));
            log("WARN", "Skipping payWinnersBatch.");
          } else {
            var t0ata = getAssociatedTokenAddressSync(THE_MINT, t0owner, false, TP);
            log("INFO", "pay ticket: " + t0.publicKey.toBase58());
            log("INFO", "pay owner:  " + t0owner.toBase58());
            log("INFO", "pay ata:    " + t0ata.toBase58());
            try {
              var txP0 = await (program.methods.payWinnersBatch(1).accounts as any)({
                draw: drawState,
                ticket: t0.publicKey,
                globalState: globalState,
                prizeVault: prizeVault,
                userTokenAccount: t0ata,
                vaultAuthority: vaultAuthority,
                tokenProgram: TP
              }).rpc();
              await confirmTx(provider, txP0);
              log("OK", "payWinnersBatch (fast-path, zero winners)");
            } catch (e: any) {
              log("INFO", "fast-path: " + (e.message || "").slice(0, 100));
            }
          }
        } else {
          log("WARN", "No tickets found for pay. Draw may already be paid.");
        }
      } else {
        var pc = 0;
        var pti: number;
        for (pti = 0; pti < payTickets.length; pti++) {
          var tk = payTickets[pti];
          var tkOwner = tk.account.user || tk.account.owner || tk.account.buyer || tk.account.player;
          if (!tkOwner || typeof tkOwner.toBase58 !== "function") continue;
          var tkAta = getAssociatedTokenAddressSync(THE_MINT, tkOwner, false, TP);
          try {
            var txPi = await (program.methods.payWinnersBatch(1).accounts as any)({
              draw: drawState,
              ticket: tk.publicKey,
              globalState: globalState,
              prizeVault: prizeVault,
              userTokenAccount: tkAta,
              vaultAuthority: vaultAuthority,
              tokenProgram: TP
            }).rpc();
            await confirmTx(provider, txPi);
            pc++;
            log("PAY", "Ticket " + (pti + 1) + "/" + payTickets.length);
          } catch (e: any) {
            var em = e.message || "";
            if (em.indexOf("NotAWinner") === -1 && em.indexOf("AlreadyPaid") === -1) {
              log("PAY", "skip: " + em.slice(0, 80));
            }
          }
          await sleep(200);
        }
        log("OK", "Paid " + pc + " winner(s)");
      }

    } else {
      log("ERR", "Unknown status: " + status);
      break;
    }

    console.log("");
    await sleep(1000);
  }

  // Final report
  var dFinal: any = await program.account.draw.fetch(drawState);
  console.log("");
  console.log("========================================================");
  console.log("  FINAL REPORT - Draw " + drawId);
  console.log("========================================================");
  console.log("");
  printDraw("FINAL", dFinal);
  console.log("  prize_per_tier: " + String(pick(dFinal, "prizePerTier", "prize_per_tier") || "N/A"));
  console.log("");

  var fs = require("fs");
  var path = require("path");
  var outDir = path.join(process.cwd(), "artifacts_batches");
  if (!fs.existsSync(outDir)) { fs.mkdirSync(outDir, { recursive: true }); }
  var outFile = path.join(outDir, "master-draw-" + drawId + ".json");
  var outData = {
    timestamp: new Date().toISOString(),
    drawId: drawId,
    drawPda: drawState.toBase58(),
    programId: program.programId.toBase58(),
    wallet: wallet.publicKey.toBase58(),
    mint: THE_MINT.toBase58(),
    tokenProgram: TP.toBase58(),
    prizeVault: prizeVault.toBase58(),
    globalState: globalState.toBase58(),
    vaultAuthority: vaultAuthority.toBase58(),
    status: dFinal.status,
    resultNumbers: pick(dFinal, "resultNumbers", "result_numbers"),
    resultCrypto: pick(dFinal, "resultCrypto", "result_crypto"),
    ticketsSold: pick(dFinal, "ticketsSold", "tickets_sold"),
    ticketsProcessed: pick(dFinal, "ticketsProcessed", "tickets_processed"),
    settlementComplete: pick(dFinal, "settlementComplete", "settlement_complete"),
    isPaid: pick(dFinal, "isPaid", "is_paid"),
    winnerCounts: pick(dFinal, "winnerCounts", "winner_counts"),
    prizePerTier: pick(dFinal, "prizePerTier", "prize_per_tier")
  };
  fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), "utf-8");
  console.log("  Output: " + outFile);
  console.log("");
}

main().catch(function(err) {
  console.error("");
  console.error("  ERROR");
  if (err.logs) {
    console.error("  Logs:");
    var li: number;
    for (li = 0; li < err.logs.length; li++) {
      console.error("    " + err.logs[li]);
    }
  }
  console.error("  " + (err.message || err));
  process.exit(1);
});
