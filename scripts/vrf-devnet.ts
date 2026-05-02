import axios from "axios";

const originalCreate = axios.create;
axios.create = function (config = {}) {
  return originalCreate({
    timeout: 7000,
    ...config,
  });
};
axios.defaults.timeout = 7000;

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, Commitment, clusterApiUrl } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import * as fs from "fs";
import * as path from "path";
import os from "os";

const COMMITMENT: Commitment = "confirmed";
const RANDOMNESS_KEYPAIR_PATH = path.join(
  process.cwd(),
  "scripts",
  "megabyt-randomness-keypair.json"
);

function loadLocalKeypair(): Keypair {
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

async function retryCommitRandomness(
  randomness: sb.Randomness,
  queuePubkey: anchor.web3.PublicKey,
  maxRetries: number = 3,
  delayMs: number = 2000
): Promise<anchor.web3.TransactionInstruction> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Commit attempt ${attempt}/${maxRetries}...`);
      const commitIx = await randomness.commitIx(queuePubkey);
      console.log("Commit instruction OK");
      return commitIx;
    } catch (error: any) {
      console.log(`Commit failed: ${error?.message ?? error}`);

      if (attempt === maxRetries) throw error;

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(Math.floor(delayMs * 1.5), 8000);
    }
  }

  throw new Error("Failed to build commit instruction");
}

async function retryRevealRandomness(
  randomness: sb.Randomness,
  maxRetries: number = 5,
  delayMs: number = 2000
): Promise<anchor.web3.TransactionInstruction> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Reveal attempt ${attempt}/${maxRetries}...`);
      const revealIx = await randomness.revealIx();
      console.log("Reveal instruction OK");
      return revealIx;
    } catch (error: any) {
      console.log(`Reveal failed: ${error?.message ?? error}`);

      if (attempt === maxRetries) throw error;

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(Math.floor(delayMs * 1.5), 10000);
    }
  }

  throw new Error("Failed to build reveal instruction");
}

async function loadOrCreateRandomnessAccount(
  sbProgram: anchor.Program,
  queuePubkey: anchor.web3.PublicKey
): Promise<{
  randomness: sb.Randomness;
  rngKp: Keypair;
  createIx?: anchor.web3.TransactionInstruction;
}> {
  let rngKp: Keypair;
  let createIx: anchor.web3.TransactionInstruction | undefined;

  if (fs.existsSync(RANDOMNESS_KEYPAIR_PATH)) {
    console.log("Loading existing randomness keypair...");
    const keypairData = JSON.parse(
      fs.readFileSync(RANDOMNESS_KEYPAIR_PATH, "utf8")
    );
    rngKp = Keypair.fromSecretKey(new Uint8Array(keypairData));

    const accountInfo = await sbProgram.provider.connection.getAccountInfo(
      rngKp.publicKey
    );

    if (accountInfo) {
      const randomness = new sb.Randomness(sbProgram, rngKp.publicKey);
      return { randomness, rngKp };
    }

    console.log("Randomness account not found on-chain. Recreating...");
    const [randomness, ix] = await sb.Randomness.create(
      sbProgram,
      rngKp,
      queuePubkey
    );
    return { randomness, rngKp, createIx: ix };
  }

  console.log("Creating new randomness keypair...");
  rngKp = Keypair.generate();

  fs.writeFileSync(
    RANDOMNESS_KEYPAIR_PATH,
    JSON.stringify(Array.from(rngKp.secretKey))
  );

  const [randomness, ix] = await sb.Randomness.create(
    sbProgram,
    rngKp,
    queuePubkey
  );
  return { randomness, rngKp, createIx: ix };
}

async function main() {
  console.log("=== MegaByt VRF Devnet Test ===");

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const keypair = loadLocalKeypair();

  console.log("Wallet:", keypair.publicKey.toBase58());
  console.log("RPC:", connection.rpcEndpoint);

  const wallet = new anchor.Wallet(keypair);

  const sbProgram = await sb.AnchorUtils.loadProgramFromConnection(
    connection,
    wallet
  );

  console.log("Switchboard program:", sbProgram.programId.toBase58());

  const balance = await connection.getBalance(keypair.publicKey);
  console.log("Wallet balance:", balance / 1e9, "SOL");

  const txOpts = {
    commitment: "processed" as Commitment,
    skipPreflight: false,
    maxRetries: 0,
  };

  const queue = await sb.Queue.loadDefault(sbProgram);
  const queuePubkey = queue.pubkey;

  console.log("Queue:", queuePubkey.toBase58());

  const { randomness, rngKp, createIx } = await loadOrCreateRandomnessAccount(
    sbProgram,
    queuePubkey
  );

  if (createIx) {
    console.log("Creating randomness account on-chain...");
    const createRandomnessTx = await sb.asV0Tx({
      connection,
      ixs: [createIx],
      payer: keypair.publicKey,
      signers: [keypair, rngKp],
      computeUnitPrice: 75_000,
      computeUnitLimitMultiple: 1.3,
    });

    const sig = await connection.sendTransaction(createRandomnessTx, txOpts);
    await connection.confirmTransaction(sig, "finalized");
    console.log("Randomness account created:", randomness.pubkey.toBase58());
    console.log("Create tx:", sig);
  } else {
    console.log("Reusing randomness account:", randomness.pubkey.toBase58());
  }

  console.log("Building commit instruction...");
  const commitIx = await retryCommitRandomness(randomness, queuePubkey);

  const commitTx = await sb.asV0Tx({
    connection,
    ixs: [commitIx],
    payer: keypair.publicKey,
    signers: [keypair],
    computeUnitPrice: 75_000,
    computeUnitLimitMultiple: 1.3,
  });

  const commitSig = await connection.sendTransaction(commitTx, txOpts);
  await connection.confirmTransaction(commitSig, COMMITMENT);
  console.log("Commit tx:", commitSig);

  console.log("Waiting 3 seconds before reveal...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("Building reveal instruction...");
  const revealIx = await retryRevealRandomness(randomness);

  const revealTx = await sb.asV0Tx({
    connection,
    ixs: [revealIx],
    payer: keypair.publicKey,
    signers: [keypair],
    computeUnitPrice: 75_000,
    computeUnitLimitMultiple: 1.3,
  });

  const revealSig = await connection.sendTransaction(revealTx, txOpts);
  await connection.confirmTransaction(revealSig, COMMITMENT);
  console.log("Reveal tx:", revealSig);

  console.log("Randomness account ready for MegaByt:");
  console.log(randomness.pubkey.toBase58());
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("VRF script failed:");
    console.error(err);
    process.exit(1);
  });

