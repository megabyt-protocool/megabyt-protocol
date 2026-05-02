/**
 * MegaByt Protocol - E2E Flow v3 (REFATORADO - SEM CRASES)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount
} from "@solana/spl-token";
import { Megabyt } from "../target/types/megabyt";

var DRAW_DURATION = new anchor.BN(process.env.DRAW_DURATION || "10");
var USER_COUNT = parseInt(process.env.USER_COUNT || "10", 10);
var USDT_PER_USER = 1000000;
var SOL_PER_USER = 0.05 * LAMPORTS_PER_SOL;

function log(s: string, m: string): void {
  console.log("  [" + s + "] " + m);
}

async function confirmTx(provider: anchor.AnchorProvider, sig: string): Promise<void> {
  var bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function uniqueNumbers(): number[] {
  var s = new Set<number>();
  while (s.size < 6) {
    s.add(Math.floor(Math.random() * 72) + 1);
  }
  return Array.from(s);
}

async function getTokenProgramForMint(connection: anchor.web3.Connection, mint: PublicKey): Promise<PublicKey> {
  var info = await connection.getAccountInfo(mint);
  if (!info) throw new Error("Mint not found: " + mint.toBase58());
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

async function ensureAndValidateAta(
  connection: anchor.web3.Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  tokenProg: PublicKey,
  label: string
): Promise<PublicKey> {
  var ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProg);
  try {
    await getAccount(connection, ata, "confirmed", tokenProg);
  } catch (e) {
    var ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, tokenProg);
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
  }
  return ata;
}

async function main(): Promise<void> {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = anchor.workspace.Megabyt as Program<Megabyt>;
  var wallet = (provider.wallet as anchor.Wallet).payer;
  var connection = provider.connection;

  console.log("\n--- CONFIG ---");
  console.log("Program: " + program.programId.toBase58());
  
  var [globalState] = PublicKey.findProgramAddressSync([Buffer.from("global-state-v3")], program.programId);
  var globalData: any = await program.account.globalState.fetch(globalState);
  var prizeVault = globalData.prizeVault || globalData.prize_vault;
  var vaultAcct = await getAccount(connection, prizeVault);
  var THE_MINT = vaultAcct.mint;
  var TP = await getTokenProgramForMint(connection, THE_MINT);

  log("TOKEN", "Mint: " + THE_MINT.toBase58());
  log("TOKEN", "Program: " + TP.toBase58());

  // Step 1: Users & SOL
  var users: Keypair[] = [];
  for (let i = 0; i < USER_COUNT; i++) users.push(Keypair.generate());
  
  for (let i = 0; i < users.length; i += 5) {
    let tx = new Transaction();
    users.slice(i, i + 5).forEach(u => {
      tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: u.publicKey, lamports: SOL_PER_USER }));
    });
    await sendAndConfirmTransaction(connection, tx, [wallet]);
    log("SOL", "Batch " + (i/5 + 1) + " funded");
  }

  // Step 2: USDT Funding
  var adminAta = await ensureAndValidateAta(connection, wallet, THE_MINT, wallet.publicKey, TP, "admin");
  var userAtas: PublicKey[] = [];
  for (let i = 0; i < users.length; i++) {
    let uAta = await ensureAndValidateAta(connection, wallet, THE_MINT, users[i].publicKey, TP, "u");
    userAtas.push(uAta);
    let ix = createTransferInstruction(adminAta, uAta, wallet.publicKey, USDT_PER_USER, [], TP);
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    if (i % 5 === 0) log("USDT", "Funded user " + i);
  }

  // Step 3: Flow Final
  var nextId = new anchor.BN(globalData.currentDrawId || 0).add(new anchor.BN(1));
  var [drawState] = PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), nextId.toArrayLike(Buffer, "le", 8)], program.programId);
  
  log("FLOW", "Opening draw " + nextId.toString());
  await (program.methods.openDraw(DRAW_DURATION).accounts as any)({
    admin: wallet.publicKey,
    globalState,
    drawState,
    systemProgram: SystemProgram.programId
  }).rpc();

  log("FLOW", "Buying tickets...");
  for (let i = 0; i < users.length; i++) {
    let [tPda] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), drawState.toBuffer(), users[i].publicKey.toBuffer()], program.programId);
    await (program.methods.buyTicket(uniqueNumbers(), 1).accounts as any)({
      user: users[i].publicKey,
      globalState,
      drawState,
      ticket: tPda,
      userTokenAccount: userAtas[i],
      prizeVault,
      tokenProgram: TP,
      systemProgram: SystemProgram.programId
    }).signers([users[i]]).rpc();
  }
  
  log("DONE", "Cycle completed up to BuyTicket.");
}

main().catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});

