import {
  Connection,
  Keypair,
  clusterApiUrl,
} from "@solana/web3.js";

import {
  AnchorProvider,
  Wallet,
} from "@coral-xyz/anchor";

import {
  Queue,
  Randomness,
} from "@switchboard-xyz/on-demand";

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

const payer = Keypair.generate();
const wallet = new Wallet(payer);

const provider = new AnchorProvider(connection, wallet, {});

(async () => {
  console.log("🚀 VRF TEST START");

  // ⚠️ precisa SOL
  console.log("Requesting airdrop...");
  await connection.requestAirdrop(payer.publicKey, 2e9);

  await new Promise((r) => setTimeout(r, 5000));

  // 🔗 usar queue padrão devnet
  const queue = await Queue.loadDevnetQueue(connection);

  console.log("Queue loaded:", queue.pubkey.toBase58());

  // 🎲 criar randomness account
  const randomness = await Randomness.create({
    payer,
    queue,
  });

  console.log("Randomness account:", randomness.pubkey.toBase58());

  // 🚀 pedir randomness
  await randomness.request();

  console.log("Randomness requested... waiting...");

  // ⏳ espera oracle responder
  await new Promise((r) => setTimeout(r, 15000));

  const result = await randomness.getValue();

  console.log("🎯 RANDOM RESULT:", result);
})();

