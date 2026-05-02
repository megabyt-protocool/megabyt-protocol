import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createMintToInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const TARGET_TICKETS = Number(process.env.TICKETS ?? "800");
const BUY_BATCH_SIZE = Number(process.env.BUY_BATCH_SIZE ?? "5");
const PLAYER_SOL_FUND = 0.003;
const PAUSE_BETWEEN_BUYS_MS = 2500;

const GLOBAL_STATE = new PublicKey("FMvkTjV9sZoy1RSptLMGenwXModkK8EF863vUrxBFRqS");
const PRIZE_VAULT = new PublicKey("F1u75nQvBa3rMHy68LT7XqrpAcAJfMwMuMbyNa2LfKYg");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== MegaByt STABLE BATCH BUY ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const admin = wallet.payer;
  const program = anchor.workspace.Megabyt as Program<any>;

  const global: any = await program.account.globalState.fetch(GLOBAL_STATE);
  const usdtMint = new PublicKey(global.usdtMint ?? global.usdt_mint);
  const ticketPrice = BigInt((global.ticketPrice ?? global.ticket_price).toString());

  const currentDrawId = Number(global.currentDrawId ?? global.current_draw_id ?? 0);
  const nextDrawId = currentDrawId + 1;

  const [drawState] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), new BN(nextDrawId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  console.log("Draw:", drawState.toBase58());

  // OPEN DRAW SAFE
  const exists = await connection.getAccountInfo(drawState);

  if (!exists) {
    console.log("Criando draw...");
    await program.methods
      .openDraw(new BN(3600))
      .accounts({
        admin: admin.publicKey,
        globalState: GLOBAL_STATE,
        drawState,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  const draw: any = await program.account.draw.fetch(drawState);

  if (!(draw.isOpen ?? draw.is_open)) {
    throw new Error("Draw não está aberta");
  }

  console.log("Draw pronta ✔");

  async function processBuy(i: number) {
    const player = Keypair.generate();

    try {
      // SOL
      await anchor.web3.sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: player.publicKey,
            lamports: PLAYER_SOL_FUND * LAMPORTS_PER_SOL,
          })
        ),
        [admin]
      );

      // ATA
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        usdtMint,
        player.publicKey
      );

      // USDT
      const info = await getAccount(connection, ata.address);

      if (info.amount < ticketPrice) {
        const missing = ticketPrice - info.amount;

        await anchor.web3.sendAndConfirmTransaction(
          connection,
          new Transaction().add(
            createMintToInstruction(
              usdtMint,
              ata.address,
              admin.publicKey,
              missing
            )
          ),
          [admin]
        );
      }

      const [ticket] = PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), drawState.toBuffer(), player.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .buyTicket([1, 2, 3, 4, 5, 6], 1)
        .accounts({
          user: player.publicKey,
          globalState: GLOBAL_STATE,
          drawState,
          ticket,
          userTokenAccount: ata.address,
          prizeVault: PRIZE_VAULT,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();

      console.log(`OK ${i + 1}`);
      return true;

    } catch (err) {
      console.log(`FAIL ${i + 1}`, err);
      return false;
    }
  }

  // BATCH LOOP
  for (let i = 0; i < TARGET_TICKETS; i += BUY_BATCH_SIZE) {
    const batch = [];

    for (let j = 0; j < BUY_BATCH_SIZE && i + j < TARGET_TICKETS; j++) {
      batch.push(processBuy(i + j));
    }

    console.log(`\nLote ${i + 1} - ${i + batch.length}`);

    const results = await Promise.allSettled(batch);

    let ok = 0;
    let fail = 0;

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) ok++;
      else fail++;
    }

    console.log(`Batch done | ok=${ok} fail=${fail}`);

    await sleep(PAUSE_BETWEEN_BUYS_MS);
  }

  console.log("\n🚀 FINALIZADO");
}

main();

