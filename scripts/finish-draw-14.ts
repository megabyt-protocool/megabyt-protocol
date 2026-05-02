import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== MegaByt Finish Draw 14 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const program = anchor.workspace.Megabyt as Program<any>;

  const globalState = new PublicKey("EM4tBuJCFjRd2BLMs61fG6Gh1Q7pEmanJTUyYdoUg1Ln");
  const drawState = new PublicKey("3aXXSmikAyPJ6mgFpcea6d3XUvCbN1E1DBFvFuyf4eHt");

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);
  console.log("GlobalState:", globalState.toBase58());
  console.log("Draw:", drawState.toBase58());

  const drawBefore = await program.account.draw.fetch(drawState);
  console.log("Status antes:", drawBefore.status);
  console.log("randomnessRequested antes:", drawBefore.randomnessRequested);
  console.log("randomnessFulfilled antes:", drawBefore.randomnessFulfilled);
  console.log("isClosed antes:", drawBefore.isClosed);

  console.log("Criando conta fake de randomness para o fallback controlado...");
  const randomness = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(512);

  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: randomness.publicKey,
        lamports: rent,
        space: 512,
        programId: program.programId,
      })
    ),
    [randomness]
  );

  console.log("Fake randomness account:", randomness.publicKey.toBase58());

  console.log("Chamando requestRandomness...");
  await program.methods
    .requestRandomness(randomness.publicKey)
    .accounts({
      admin: admin.publicKey,
      globalState,
      draw: drawState,
      randomnessAccount: randomness.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Chamando fulfillRandomness com mock seed...");
  const mockSeed = Array.from({ length: 32 }, (_, i) => i + 1);

  await program.methods
    .fulfillRandomness(mockSeed)
    .accounts({
      admin: admin.publicKey,
      globalState,
      draw: drawState,
    })
    .rpc();

  console.log("Esperando 5s...");
  await sleep(5000);

  const drawMid = await program.account.draw.fetch(drawState);
  console.log("Status depois fulfill:", drawMid.status);
  console.log("randomnessRequested depois fulfill:", drawMid.randomnessRequested);
  console.log("randomnessFulfilled depois fulfill:", drawMid.randomnessFulfilled);
  console.log("isClosed depois fulfill:", drawMid.isClosed);

  console.log("Chamando closeDraw...");
  await program.methods
    .closeDraw()
    .accounts({
      draw: drawState,
      randomnessAccountData: randomness.publicKey,
    })
    .rpc();

  const drawAfter = await program.account.draw.fetch(drawState);
  console.log("=== SUCESSO ===");
  console.log("Status final:", drawAfter.status);
  console.log("randomnessRequested final:", drawAfter.randomnessRequested);
  console.log("randomnessFulfilled final:", drawAfter.randomnessFulfilled);
  console.log("isClosed final:", drawAfter.isClosed);
  console.log("Draw 14 fechada:", drawState.toBase58());
}

main().catch((err) => {
  console.error("Erro:", err);
  process.exit(1);
});

