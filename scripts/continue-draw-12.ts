import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

const DRAW = new PublicKey("BBCA6i3XP9srRYWeqfpqUB8SZp2yJemDjfeToxSHzM9Q");

async function main() {
  console.log("=== Continue Draw 12 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const admin = provider.wallet as anchor.Wallet;

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state")],
    program.programId
  );

  console.log("Draw:", DRAW.toBase58());

  const drawBefore = await program.account.draw.fetch(DRAW);
  console.log("Já vendidos:", Number(drawBefore.ticketsSold));
  console.log("Total vendido antes do randomness:", Number(drawBefore.ticketsSold));

  console.log("Requesting randomness...");

  // Continua usando uma conta qualquer só para satisfazer a assinatura do request.
  // O fechamento real aqui será via fallback com fulfillRandomness(mockSeed).
  const randomnessAccountData = Keypair.generate();
  const randomnessSpace = 8 + 64;
  const randomnessLamports =
    await provider.connection.getMinimumBalanceForRentExemption(randomnessSpace);

  const createRandomnessIx = anchor.web3.SystemProgram.createAccount({
    fromPubkey: admin.publicKey,
    newAccountPubkey: randomnessAccountData.publicKey,
    lamports: randomnessLamports,
    space: randomnessSpace,
    programId: program.programId,
  });

  const tx = new anchor.web3.Transaction().add(createRandomnessIx);
  await provider.sendAndConfirm(tx, [randomnessAccountData]);

  await program.methods
    .requestRandomness(randomnessAccountData.publicKey)
    .accounts({
      admin: admin.publicKey,
      globalState,
      draw: DRAW,
      randomnessAccount: randomnessAccountData.publicKey,
    })
    .rpc();

  console.log("Fulfill randomness com mock seed (fallback controlado)...");
  const mockSeed = Array.from({ length: 32 }, (_, i) => i + 1);

  await program.methods
    .fulfillRandomness(mockSeed)
    .accounts({
      admin: admin.publicKey,
      globalState,
      draw: DRAW,
    })
    .rpc();

  console.log("Closing draw...");
  await program.methods
    .closeDraw()
    .accounts({
      draw: DRAW,
      randomnessAccountData: randomnessAccountData.publicKey,
    })
    .rpc();

  let drawState = await program.account.draw.fetch(DRAW);
  console.log("Status após closeDraw:", Number(drawState.status));
  console.log("isClosed:", drawState.isClosed);
  console.log("settled:", drawState.settled);
  console.log("settlementComplete:", drawState.settlementComplete);
  console.log("ticketsProcessed:", Number(drawState.ticketsProcessed));
  console.log("ticketsSold:", Number(drawState.ticketsSold));

  if (!drawState.settlementComplete) {
    console.log("Iniciando settlement em lotes...");

    while (true) {
      drawState = await program.account.draw.fetch(DRAW);

      if (drawState.settlementComplete) {
        break;
      }

      await program.methods
        .settleTickets(new anchor.BN(25))
        .accounts({
          admin: admin.publicKey,
          globalState,
          draw: DRAW,
        })
        .rpc();

      drawState = await program.account.draw.fetch(DRAW);
      console.log(
        `Processados: ${Number(drawState.ticketsProcessed)} / ${Number(drawState.ticketsSold)}`
      );

      if (drawState.settlementComplete) {
        break;
      }
    }
  }

  drawState = await program.account.draw.fetch(DRAW);
  console.log("Settlement complete:", drawState.settlementComplete);
  console.log("Status antes do finalize:", Number(drawState.status));

  console.log("Finalizing payouts...");
  await program.methods
    .finalizePayouts()
    .accounts({
      admin: admin.publicKey,
      globalState,
      draw: DRAW,
    })
    .rpc();

  drawState = await program.account.draw.fetch(DRAW);
  console.log("=== FINAL ===");
  console.log("Status final:", Number(drawState.status));
  console.log("isClosed:", drawState.isClosed);
  console.log("settled:", drawState.settled);
  console.log("settlementComplete:", drawState.settlementComplete);
  console.log("ticketsSold:", Number(drawState.ticketsSold));
  console.log("ticketsProcessed:", Number(drawState.ticketsProcessed));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

