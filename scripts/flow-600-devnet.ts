// 🔥 PATCHED VERSION — RESUME INTELIGENTE ATIVO

var anchor = require("@coral-xyz/anchor");
var {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram
} = require("@solana/web3.js");

var {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction
} = require("@solana/spl-token");

var fs = require("fs");
var path = require("path");
var IDL = require("../target/idl/megabyt.json");

// ===== CONFIG =====
var TICKETS = parseInt(process.env.TICKETS || "600", 10);
var MULTI = parseInt(process.env.MULTI || "5", 10);
var BATCH_SETTLE = 20;

var USERS_NEEDED = Math.ceil(TICKETS / MULTI);
var SOL_PER_WALLET = 0.015 * MULTI;

var CHECKPOINT_FILE = path.join(__dirname, "..", "artifacts_batches", "flow-600-checkpoint.json");

// ===== HELPERS =====
function log(tag: string, msg: string) {
  console.log("[" + tag + "] " + msg);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== CHECKPOINT =====
function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) return null;
  return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8"));
}

// ===== MAIN =====
async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new anchor.Program(IDL, provider);
  const wallet = provider.wallet.payer;
  const conn = provider.connection;

  const cp = loadCheckpoint();

  const adminBal = await conn.getBalance(wallet.publicKey);
  const adminSol = adminBal / LAMPORTS_PER_SOL;

  // 🔥 PATCH PRINCIPAL
  let requiredSol = 9;
  let mode = "FULL";

  if (cp && cp.phase !== "buy") {
    requiredSol = 0.75;
    mode = "RESUME";
  }

  console.log("\n=== PREFLIGHT ===");
  console.log("Mode:", mode);
  console.log("SOL:", adminSol);

  if (adminSol < requiredSol) {
    console.error("ABORT: SOL insuficiente:", adminSol, "<", requiredSol);
    process.exit(1);
  }

  console.log("OK: saldo suficiente\n");

  // ===== RESUME FLOW =====
  if (cp) {
    console.log("=== RESUMING ===");
    console.log("Phase:", cp.phase);

    const drawPda = new PublicKey(cp.drawPda);

    if (cp.phase === "settle") {
      console.log("→ SETTLE");

      for (let i = 0; i < cp.ticketPdas.length; i += BATCH_SETTLE) {
        const slice = cp.ticketPdas.slice(i, i + BATCH_SETTLE);

        const rem = slice.map((k: string) => ({
          pubkey: new PublicKey(k),
          isWritable: true,
          isSigner: false
        }));

        await program.methods
          .settleTickets(rem.length)
          .accounts({ draw: drawPda })
          .remainingAccounts(rem)
          .rpc();

        console.log("SETTLE", i + slice.length, "/", cp.ticketPdas.length);
        await sleep(200);
      }

      cp.phase = "finalize";
    }

    if (cp.phase === "finalize") {
      console.log("→ FINALIZE");

      await program.methods
        .finalizePayouts()
        .accounts({
          globalState: cp.globalState,
          draw: drawPda
        })
        .rpc();

      console.log("FINALIZED");

      cp.phase = "pay";
    }

    if (cp.phase === "pay") {
      console.log("→ PAY");

      for (let t of cp.ticketPdas) {
        try {
          await program.methods
            .payWinnersBatch(1)
            .accounts({
              draw: drawPda,
              ticket: new PublicKey(t),
              globalState: cp.globalState,
              prizeVault: cp.prizeVault,
              userTokenAccount: cp.userAta,
              vaultAuthority: cp.vaultAuthority,
              tokenProgram: cp.tokenProgram
            })
            .rpc();
        } catch {}
      }

      console.log("DONE");
    }

    return;
  }

  console.log("Nenhum checkpoint encontrado.");
}

main();

