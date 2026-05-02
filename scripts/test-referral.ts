import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo
} from "@solana/spl-token";

var IDL = require("../target/idl/megabyt.json");

async function main() {
  console.log("=== TEST REFERRAL FLOW ===");

  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = new Program(IDL, provider) as any;

  var connection = provider.connection;
  var admin = (provider.wallet as any).payer;

  var TICKET_PRICE = 10000000;

  var referrer = Keypair.generate();
  var user = Keypair.generate();

  console.log("Referrer: " + referrer.publicKey.toBase58());
  console.log("User: " + user.publicKey.toBase58());

  // Fund SOL
  for (var ki = 0; ki < 2; ki++) {
    var kp = ki === 0 ? referrer : user;
    var tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: kp.publicKey,
        lamports: 0.2 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    var sig = await provider.sendAndConfirm(tx, []);
    console.log("SOL sent to " + kp.publicKey.toBase58());
  }

  // Global state
  var gsRes = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")], program.programId
  );
  var globalState = gsRes[0];

  var global = await program.account.globalState.fetch(globalState);
  var mint = new PublicKey(global.tokenMint);

  // Token accounts
  var referrerToken = await getOrCreateAssociatedTokenAccount(
    connection, admin, mint, referrer.publicKey
  );

  var userToken = await getOrCreateAssociatedTokenAccount(
    connection, admin, mint, user.publicKey
  );

  await mintTo(connection, admin, mint, userToken.address, admin, TICKET_PRICE);
  console.log("User funded with USDT");

  // User states
  var refStateRes = PublicKey.findProgramAddressSync(
    [Buffer.from("user-state-v3"), referrer.publicKey.toBuffer()], program.programId
  );
  var referrerStatePda = refStateRes[0];

  var usStateRes = PublicKey.findProgramAddressSync(
    [Buffer.from("user-state-v3"), user.publicKey.toBuffer()], program.programId
  );
  var userStatePda = usStateRes[0];

  // Init referrer state
  await (program.methods.initUserState().accounts as any)({
    user: referrer.publicKey,
    userState: referrerStatePda,
    systemProgram: SystemProgram.programId
  }).signers([referrer]).rpc();

  // Init user state
  await (program.methods.initUserState().accounts as any)({
    user: user.publicKey,
    userState: userStatePda,
    systemProgram: SystemProgram.programId
  }).signers([user]).rpc();

  console.log("UserStates initialized");

  // Set referrer
  await (program.methods.setReferrer().accounts as any)({
    user: user.publicKey,
    userState: userStatePda,
    referrerState: referrerStatePda
  }).signers([user]).rpc();

  console.log("Referrer set");

  // Open draw (use currentDrawId + 1)
  var currentGlobal = await program.account.globalState.fetch(globalState);
  var nextId = new BN(currentGlobal.currentDrawId).add(new BN(1));

  var drawRes = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), nextId.toArrayLike(Buffer, "le", 8)], program.programId
  );
  var drawStatePda = drawRes[0];

  await (program.methods.openDraw(new BN(300)).accounts as any)({
    admin: admin.publicKey,
    globalState: globalState,
    drawState: drawStatePda,
    systemProgram: SystemProgram.programId
  }).rpc();

  // Re-read to confirm actual draw id
  var afterOpen = await program.account.globalState.fetch(globalState);
  var drawId = new BN(afterOpen.currentDrawId);
  var drawConfRes = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), drawId.toArrayLike(Buffer, "le", 8)], program.programId
  );
  var drawState = drawConfRes[0];

  console.log("Draw opened: id=" + drawId.toString() + " pda=" + drawState.toBase58());

  // Buy ticket with referral
  var ticketRes = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), drawState.toBuffer(), user.publicKey.toBuffer()], program.programId
  );
  var ticket = ticketRes[0];

  await (program.methods.buyTicketWithReferral(
    [1, 2, 3, 4, 5, 6],
    1
  ).accounts as any)({
    user: user.publicKey,
    globalState: globalState,
    drawState: drawState,
    ticket: ticket,
    userTokenAccount: userToken.address,
    prizeVault: new PublicKey(global.prizeVault),
    userState: userStatePda,
    referrerState: referrerStatePda,
    referrerTokenAccount: referrerToken.address,
    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId
  }).signers([user]).rpc();

  console.log("BUY WITH REFERRAL DONE");

  // Check result
  var refState = await program.account.userState.fetch(referrerStatePda);

  console.log("");
  console.log("=== RESULT ===");
  console.log("Referral Earned: " + refState.totalReferralEarned.toString());
  console.log("Successful Referrals: " + refState.successfulReferrals.toString());
  console.log("Bonus Credits: " + refState.bonusTicketCredits.toString());

  var usState = await program.account.userState.fetch(userStatePda);
  console.log("User counted_as_conversion: " + usState.countedAsReferralConversion);
  console.log("");
  console.log("Done.");
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
