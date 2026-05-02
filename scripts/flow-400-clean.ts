import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";

const idl = require("../target/idl/megabyt.json");

const PROGRAM_ID = new PublicKey("Gv3ZyzmkbqaH3m8HJ9c4hX3ozc9Lb5gM7xWsqxMvGEos");

const VRF_ACCOUNT = new PublicKey("DHA2a6jZiHM65NZTGWVEtXC8c4Z8hm4GpaZTNsL8X8rn");

const TOTAL_TICKETS = 400;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomNumbers() {
  const nums = new Set<number>();
  while (nums.size < 6) {
    nums.add(Math.floor(Math.random() * 72) + 1);
  }
  return Array.from(nums);
}

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new anchor.Program(idl, PROGRAM_ID, provider);
  const connection = provider.connection;
  const wallet = provider.wallet;

  console.log("=== FLOW 400 CLEAN ===");

  // =========================
  // GLOBAL STATE (V3)
  // =========================
  const GLOBAL_STATE = new PublicKey("FMvkTjV9sZoy1RSptLMGenwXModkK8EF863vUrxBFRqS");

  // =========================
  // OPEN DRAW
  // =========================
  console.log("=== OPEN DRAW ===");

  const drawId = Date.now(); // simples pra não colidir

  const [drawPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("draw-v3"),
      new anchor.BN(drawId).toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID
  );

  await program.methods.openDraw(new anchor.BN(drawId))
    .accounts({
      admin: wallet.publicKey,
      globalState: GLOBAL_STATE,
      draw: drawPda,
    })
    .rpc();

  console.log("Draw:", drawPda.toBase58());

  // =========================
  // BUY 400 TICKETS
  // =========================
  console.log("=== BUY TICKETS ===");

  for (let i = 0; i < TOTAL_TICKETS; i++) {
    const user = Keypair.generate();

    await provider.connection.requestAirdrop(user.publicKey, 1e9);
    await sleep(500);

    const nums = randomNumbers();
    const crypto = Math.floor(Math.random() * 10) + 1;

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("ticket"),
        drawPda.toBuffer(),
        user.publicKey.toBuffer(),
      ],
      PROGRAM_ID
    );

    try {
      await program.methods.buyTicket(nums, crypto)
        .accounts({
          user: user.publicKey,
          draw: drawPda,
          ticket: ticketPda,
        })
        .signers([user])
        .rpc();

      console.log(`ticket ${i + 1}`);
    } catch (e) {
      console.log("fail ticket", i);
    }
  }

  // =========================
  // REQUEST RANDOMNESS
  // =========================
  console.log("=== REQUEST RANDOMNESS ===");

  await program.methods.requestRandomness()
    .accounts({
      admin: wallet.publicKey,
      globalState: GLOBAL_STATE,
      draw: drawPda,
      randomnessAccount: VRF_ACCOUNT,
    })
    .rpc();

  console.log("waiting VRF...");
  await sleep(10000);

  // =========================
  // CLOSE DRAW
  // =========================
  console.log("=== CLOSE DRAW ===");

  await program.methods.closeDraw()
    .accounts({
      admin: wallet.publicKey,
      globalState: GLOBAL_STATE,
      draw: drawPda,
      randomnessAccountData: VRF_ACCOUNT,
    })
    .rpc();

  // =========================
  // SETTLE
  // =========================
  console.log("=== SETTLE ===");

  for (let i = 0; i < 20; i++) {
    await program.methods.settleTickets(new anchor.BN(50))
      .accounts({
        admin: wallet.publicKey,
        globalState: GLOBAL_STATE,
        draw: drawPda,
      })
      .rpc();

    await sleep(2000);
  }

  // =========================
  // FINALIZE
  // =========================
  console.log("=== FINALIZE ===");

  await program.methods.finalizePayouts()
    .accounts({
      admin: wallet.publicKey,
      globalState: GLOBAL_STATE,
      draw: drawPda,
    })
    .rpc();

  console.log("=== DONE ===");
})();

