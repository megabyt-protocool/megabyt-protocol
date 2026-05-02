import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const IDL = require("../target/idl/megabyt.json");

const EXPECTED_PROGRAM_ID = "Gv3ZyzmkbqaH3m8HJ9c4hX3ozc9Lb5gM7xWsqxMvGEos";
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const TICKETS_TO_BUY = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomNumbers6of72(): number[] {
  const s = new Set<number>();
  while (s.size < 6) {
    s.add(Math.floor(Math.random() * 72) + 1);
  }
  return [...s].sort((a, b) => a - b);
}

function randomCrypto1of10(): number {
  return Math.floor(Math.random() * 10) + 1;
}

async function airdropIfNeeded(
  connection: Connection,
  pubkey: PublicKey,
  minSol = 0.03
) {
  const bal = await connection.getBalance(pubkey);
  const minLamports = minSol * LAMPORTS_PER_SOL;
  if (bal >= minLamports) return;

  const sig = await connection.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function main() {
  console.log("=== MegaByt Stress Flow Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program(IDL, provider) as Program<any>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());

  if (program.programId.toBase58() !== EXPECTED_PROGRAM_ID) {
    throw new Error(
      `Program ID diferente do esperado: ${program.programId.toBase58()} != ${EXPECTED_PROGRAM_ID}`
    );
  }

  const adminBalance = await connection.getBalance(admin.publicKey);
  console.log("Admin balance:", adminBalance / LAMPORTS_PER_SOL, "SOL");

  // ===== PDAs principais =====
  const [globalStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v2")],
    program.programId
  );

  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority")],
    program.programId
  );

  const [prizeVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("prize-vault")],
    program.programId
  );

  console.log("GlobalState:", globalStatePda.toBase58());
  console.log("VaultAuthority:", vaultAuthorityPda.toBase58());
  console.log("PrizeVault:", prizeVaultPda.toBase58());

  // ===== Reutiliza GlobalState já existente =====
  const globalState: any = await program.account.globalState.fetch(globalStatePda);

  const usdtMint = new PublicKey(globalState.usdtMint);
  console.log("USDT Mint:", usdtMint.toBase58());

  const currentDrawId = Number(globalState.currentDrawId);
  const nextDrawId = currentDrawId + 1;

  console.log("Current draw id:", currentDrawId);
  console.log("Opening draw id:", nextDrawId);

  const [drawPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw"), new BN(nextDrawId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  console.log("Draw PDA:", drawPda.toBase58());

  // ===== Open Draw =====
  console.log("\n=== Step 1: Open Draw ===");
  try {
    const txOpen = await program.methods
      .openDraw(new BN(3600))
      .accounts({
        globalState: globalStatePda,
        drawState: drawPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("open_draw tx:", txOpen);
    await sleep(3000);
  } catch (e: any) {
    console.log("open_draw aviso:", e?.message || e);
    console.log("Tentando seguir mesmo assim...");
  }

  // ===== Compra 100 tickets com multi-wallet =====
  console.log(`\n=== Step 2: Buy ${TICKETS_TO_BUY} tickets ===`);

  const players: {
    wallet: Keypair;
    ata: PublicKey;
    ticketPda: PublicKey;
    numbers: number[];
    crypto: number;
  }[] = [];

  for (let i = 0; i < TICKETS_TO_BUY; i++) {
    const player = Keypair.generate();

    

    const transferSig = await connection.sendTransaction(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: player.publicKey,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        })
      ),
      [admin],
      { skipPreflight: false, preflightCommitment: "confirmed" }
    );
    await connection.confirmTransaction(transferSig, "confirmed");

    const playerAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      usdtMint,
      player.publicKey
    );

    await mintTo(
      connection,
      admin,
      usdtMint,
      playerAta.address,
      admin,
      2_000_000
    );

    const numbers = randomNumbers6of72();
    const crypto = randomCrypto1of10();

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), drawPda.toBuffer(), player.publicKey.toBuffer()],
      program.programId
    );

    const playerProvider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(player),
      provider.opts
    );
    const playerProgram = new Program(IDL, playerProvider) as Program<any>;

    try {
      const txBuy = await playerProgram.methods
        .buyTicket(numbers, crypto)
        .accounts({
          globalState: globalStatePda,
          drawState: drawPda,
          ticket: ticketPda,
          user: player.publicKey,
          userTokenAccount: playerAta.address,
          prizeVault: prizeVaultPda,
          vaultAuthority: vaultAuthorityPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();

      console.log(
        `[${i + 1}/${TICKETS_TO_BUY}] buy_ticket ok: ${txBuy} | ${player.publicKey.toBase58()}`
      );

      players.push({
        wallet: player,
        ata: playerAta.address,
        ticketPda,
        numbers,
        crypto,
      });
    } catch (e: any) {
      console.log(
        `[${i + 1}/${TICKETS_TO_BUY}] buy_ticket erro:`,
        e?.message || e
      );
    }

    await sleep(250);
  }

  console.log("Tickets comprados com sucesso:", players.length);

  // ===== Randomness account =====
  console.log("\n=== Step 3: Request Randomness ===");

  const randomness = Keypair.generate();
  console.log("Randomness pubkey:", randomness.publicKey.toBase58());

  try {
    const txReq = await program.methods
      .requestRandomness(randomness.publicKey)
      .accounts({
        globalState: globalStatePda,
        drawState: drawPda,
        admin: admin.publicKey,
        randomnessAccount: randomness.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("request_randomness tx:", txReq);
  } catch (e: any) {
    console.log("request_randomness erro:", e?.message || e);
    console.log("Parando aqui para não fechar draw sem randomness.");
    return;
  }

  console.log("Aguardando VRF...");
  await sleep(15000);

  // ===== Close Draw =====
  console.log("\n=== Step 4: Close Draw ===");
  try {
    const txClose = await program.methods
      .closeDraw()
      .accounts({
        globalState: globalStatePda,
        drawState: drawPda,
        admin: admin.publicKey,
        randomnessAccountData: randomness.publicKey,
      })
      .rpc();

    console.log("close_draw tx:", txClose);
    await sleep(4000);
  } catch (e: any) {
    console.log("close_draw erro:", e?.message || e);
    return;
  }

  // ===== Settle =====
  console.log("\n=== Step 5: Settle Tickets ===");
  try {
    const txSettle = await program.methods
      .settleTickets()
      .accounts({
        globalState: globalStatePda,
        drawState: drawPda,
        admin: admin.publicKey,
      })
      .rpc();

    console.log("settle_tickets tx:", txSettle);
    await sleep(3000);
  } catch (e: any) {
    console.log("settle_tickets erro:", e?.message || e);
    return;
  }

  // ===== Finalize payouts =====
  console.log("\n=== Step 6: Finalize Payouts ===");
  try {
    const txFinalize = await program.methods
      .finalizePayouts()
      .accounts({
        globalState: globalStatePda,
        drawState: drawPda,
        admin: admin.publicKey,
      })
      .rpc();

    console.log("finalize_payouts tx:", txFinalize);
    await sleep(3000);
  } catch (e: any) {
    console.log("finalize_payouts erro:", e?.message || e);
    return;
  }

  // ===== Pay winners batch =====
  console.log("\n=== Step 7: Pay Winners Batch ===");

  let paid = 0;

  for (const p of players) {
    try {
      const txPay = await program.methods
        .payWinnersBatch(new BN(1))
        .accounts({
          globalState: globalStatePda,
          drawState: drawPda,
          ticket: p.ticketPda,
          userTokenAccount: p.ata,
          prizeVault: prizeVaultPda,
          vaultAuthority: vaultAuthorityPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("pay_winners_batch tx:", txPay);
      paid++;
      await sleep(200);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (
        msg.includes("No winners") ||
        msg.includes("Nothing to pay") ||
        msg.includes("already paid")
      ) {
        continue;
      }
      console.log("pay_winners_batch erro:", msg);
    }
  }

  console.log("\n=== DONE ===");
  console.log("Tickets comprados:", players.length);
  console.log("Pagamentos tentados:", paid);

  try {
    const draw: any = await program.account.draw.fetch(drawPda);
    console.log("Draw status:", Number(draw.status));
    console.log("Tickets sold:", Number(draw.ticketsSold));
    console.log("Tickets processed:", Number(draw.ticketsProcessed));
    console.log("Settlement complete:", draw.settlementComplete);
    console.log("Is paid:", draw.isPaid);
    console.log("Result numbers:", draw.resultNumbers);
    console.log("Result crypto:", draw.resultCrypto);
  } catch (e: any) {
    console.log("Não foi possível reler draw no final:", e?.message || e);
  }
}

main().catch((err) => {
  console.error("Erro:", err);
  process.exit(1);
});

