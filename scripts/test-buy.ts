import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const GLOBAL = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");
const MINT = new PublicKey("HkahNWz3FB53wYNKgZaEYrrC3K9DbQoWuydKM2HPqiUd");
const VAULT = new PublicKey("8sEKCpLjLLZzRjwKXfn5ubYhuJu2jdYFa5ngqbTyw7mz");

function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt;
  const conn = provider.connection;
  const payer = provider.wallet as any;

  console.log("=== TEST BUY ===");

  // 1. pegar draw atual
  const global: any = await program.account.globalState.fetch(GLOBAL);
  const drawId = global.currentDrawId.toNumber();

  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(drawId), 0);

  const [draw] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), buf],
    program.programId
  );

  console.log("Draw:", draw.toBase58());

  // 2. criar user novo
  const user = Keypair.generate();
  console.log("User:", user.publicKey.toBase58());

  // 3. enviar SOL (SEM AIRDROP)
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: user.publicKey,
      lamports: 0.02 * anchor.web3.LAMPORTS_PER_SOL,
    })
  );

  await conn.sendTransaction(tx, [payer.payer]);
  await sleep(1000);

  console.log("SOL enviado");

  // 4. criar ATA
  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    payer.payer,
    MINT,
    user.publicKey
  );

  console.log("ATA:", ata.address.toBase58());

  // 5. mintar token
  await mintTo(
    conn,
    payer.payer,
    MINT,
    ata.address,
    payer.payer,
    2_000_000 // 2 tokens (decimals 6)
  );

  console.log("Tokens mintados");

  // 6. derivar PDAs
  const [userDrawState] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user-draw"), draw.toBuffer(), user.publicKey.toBuffer()],
    program.programId
  );

  const [ticket] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("ticket"),
      draw.toBuffer(),
      user.publicKey.toBuffer(),
      u32(0),
    ],
    program.programId
  );

  // 7. dados do ticket
  const nums = [1, 2, 3, 4, 5, 6];
  const crypto = 1;

  console.log("Enviando buyTicket...");

  // 8. comprar ticket
  await program.methods
    .buyTicket(nums, crypto)
    .accounts({
      user: user.publicKey,
      globalState: GLOBAL,
      drawState: draw,
      userDrawState,
      ticket,
      userTokenAccount: ata.address,
      prizeVault: VAULT,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();

  console.log("✅ OK — ticket comprado");
})();

