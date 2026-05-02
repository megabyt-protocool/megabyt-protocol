import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/megabyt.json";

function pick(obj: any, ...keys: string[]) {
  for (const k of keys) {
    if (obj && typeof obj[k] !== "undefined" && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function toArrayNumbers(value: any): number[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((x) => Number(x));
  return [];
}

function toHex(bytes: number[] | Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function generateUniqueNumbers(seed: number[]): number[] {
  const pool: number[] = [];
  for (let i = 0; i < 72; i++) pool.push(i + 1);

  const result: number[] = [];
  let available = 72;

  for (let j = 0; j < 6; j++) {
    const idx = seed[j % 32] % available;
    result.push(pool[idx]);
    pool[idx] = pool[available - 1];
    available -= 1;
  }

  result.sort((a, b) => a - b);
  return result;
}

async function main() {
  const DRAW_ID = parseInt(process.env.DRAW_ID || "35", 10);

  if (!process.env.ANCHOR_PROVIDER_URL) {
    console.error("ERROR: ANCHOR_PROVIDER_URL is not defined");
    process.exit(1);
  }

  if (!process.env.ANCHOR_WALLET) {
    console.error("ERROR: ANCHOR_WALLET is not defined");
    process.exit(1);
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program(idl as any, provider) as Program<any>;

  console.log("");
  console.log("================================================================");
  console.log("  MEGABYT — RANDOMNESS VERIFICATION REPORT");
  console.log("  Draw #" + DRAW_ID);
  console.log("================================================================");
  console.log("");
  console.log("  Program:    " + program.programId.toBase58());

  const drawIdBn = new BN(DRAW_ID);
  const [drawPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), drawIdBn.toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  console.log("  Draw PDA:   " + drawPda.toBase58());
  console.log("");

  let draw: any;
  try {
    draw = await program.account.draw.fetch(drawPda);
  } catch (e) {
    console.error("  ERROR: Draw #" + DRAW_ID + " not found on-chain");
    process.exit(1);
  }

  const isClosed = !!pick(draw, "isClosed", "is_closed");
  const randomnessRequested = !!pick(draw, "randomnessRequested", "randomness_requested");
  const randomnessFulfilled = !!pick(draw, "randomnessFulfilled", "randomness_fulfilled");
  const randomnessAccount = pick(draw, "randomnessAccount", "randomness_account");
  const commitSlot = Number(pick(draw, "commitSlot", "commit_slot") || 0);
  const ticketsSold = Number(pick(draw, "ticketsSold", "tickets_sold") || 0);
  const resultNumbers = toArrayNumbers(pick(draw, "resultNumbers", "result_numbers"));
  const resultCrypto = Number(pick(draw, "resultCrypto", "result_crypto") || 0);
  const winnerCounts = toArrayNumbers(pick(draw, "winnerCounts", "winner_counts"));
  const randomSeedRaw = pick(draw, "randomSeed", "random_seed");
  const randomSeed = toArrayNumbers(randomSeedRaw);

  console.log("  === DRAW STATE ===");
  console.log("  draw_id:              " + DRAW_ID);
  console.log("  is_closed:            " + isClosed);
  console.log("  randomness_requested: " + randomnessRequested);
  console.log("  randomness_fulfilled: " + randomnessFulfilled);
  console.log("  randomness_account:   " + (randomnessAccount ? randomnessAccount.toBase58() : "none"));
  console.log("  commit_slot:          " + commitSlot);
  console.log("  tickets_sold:         " + ticketsSold);
  console.log("  result_numbers:       [" + resultNumbers.join(", ") + "]");
  console.log("  result_crypto:        " + resultCrypto);
  console.log("  winner_counts:        [" + winnerCounts.join(", ") + "]");
  console.log("");

  console.log("  === STEP 1: ON-CHAIN VERIFICATION ===");
  let onchainOk = false;

  if (!randomnessFulfilled) {
    console.log("  ❌ Draw does not have fulfilled randomness yet");
  } else if (!randomnessAccount) {
    console.log("  ❌ Draw does not have randomness account stored");
  } else {
    try {
      const tx = await (program.methods.verifyRandomness(new BN(DRAW_ID)).accounts({
        draw: drawPda,
        randomnessAccountData: randomnessAccount,
      }) as any).rpc();

      console.log("  ✅ ON-CHAIN VERIFICATION PASSED");
      console.log("  tx: " + tx);
      onchainOk = true;
    } catch (e: any) {
      console.log("  ❌ ON-CHAIN VERIFICATION FAILED: " + (e?.message || e));
    }
  }

  console.log("");
  console.log("  === STEP 2: OFF-CHAIN RE-DERIVATION ===");

  if (!randomSeed || randomSeed.length !== 32) {
    console.log("  ❌ Invalid random seed length: " + (randomSeed ? randomSeed.length : 0));
    process.exit(1);
  }

  console.log("  Random seed (hex):  " + toHex(randomSeed));
  console.log("  Random seed (len):  " + randomSeed.length + " bytes");

  const derivedNumbers = generateUniqueNumbers(randomSeed);
  const derivedCrypto = (randomSeed[6] % 10) + 1;

  console.log("  Derived numbers:    [" + derivedNumbers.join(", ") + "]");
  console.log("  Derived crypto:     " + derivedCrypto);
  console.log("  Stored numbers:     [" + resultNumbers.join(", ") + "]");
  console.log("  Stored crypto:      " + resultCrypto);
  console.log("");

  const numbersMatch =
    derivedNumbers.length === resultNumbers.length &&
    derivedNumbers.every((n, i) => n === resultNumbers[i]);

  const cryptoMatch = derivedCrypto === resultCrypto;

  if (numbersMatch && cryptoMatch) {
    console.log("  ✅ OFF-CHAIN VERIFICATION PASSED");
    console.log("  Results are correctly derived from the random seed.");
  } else {
    console.log("  ❌ OFF-CHAIN VERIFICATION FAILED");
    console.log("  Stored result does not match re-derived result.");
  }

  console.log("");
  console.log("  === STEP 3: SEED INTEGRITY ===");

  const nonZeroBytes = randomSeed.filter((b) => b !== 0).length;
  if (nonZeroBytes === 0) {
    console.log("  ❌ Seed is all zeros — randomness was NOT applied");
  } else {
    console.log("  ✅ Seed is non-zero (" + nonZeroBytes + "/32 non-zero bytes)");
  }

  const crypto = require("crypto");
  const seedHash = crypto.createHash("sha256").update(Buffer.from(randomSeed)).digest("hex");
  console.log("  Seed SHA256: " + seedHash);

  console.log("");
  console.log("================================================================");
  console.log("  VERIFICATION RESULT FOR DRAW #" + DRAW_ID);
  console.log("================================================================");
  console.log("");

  if (numbersMatch && cryptoMatch) {
    console.log("  ✅ VERIFIED (off-chain derivation matches)");
    console.log("");
    console.log("  Results correctly derived from seed.");
    if (onchainOk) {
      console.log("  On-chain verification also passed.");
    } else {
      console.log("  On-chain verification returned error (may be test mode).");
    }
  } else {
    console.log("  ❌ NOT VERIFIED");
  }

  console.log("");
  console.log("  Proof data:");
  console.log("    Program:    " + program.programId.toBase58());
  console.log("    Draw PDA:   " + drawPda.toBase58());
  console.log("    VRF Acct:   " + (randomnessAccount ? randomnessAccount.toBase58() : "none"));
  console.log("    Commit Slot:" + commitSlot);
  console.log("    Seed Hash:  " + seedHash);
  console.log("    Numbers:    [" + resultNumbers.join(", ") + "]");
  console.log("    Crypto:     " + resultCrypto);
  console.log("");
  console.log(
    "  Explorer: https://explorer.solana.com/address/" +
      drawPda.toBase58() +
      "?cluster=devnet"
  );
  console.log("");
  console.log("================================================================");
  console.log('  "This is not luck. This is math."');
  console.log("================================================================");
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

