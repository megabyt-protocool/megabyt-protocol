const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, ComputeBudgetProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } = require("@solana/spl-token");
const IDL = require("../target/idl/megabyt.json");

const NUM_TICKETS = 10;
const SETTLE_BATCH = 50;

function log(tag, msg) { console.log(`  [${tag}] ${msg}`); }
function hr() { console.log("================================================================"); }
function step(n, t) { hr(); console.log(`  STEP ${n}: ${t}`); hr(); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function pick(o,a,b){ return o?.[a] ?? o?.[b] ?? null; }

async function confirmTx(conn, sig) {
  const bh = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction({
    signature: sig,
    blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
  }, "confirmed");
}

function u32le(n){
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n,0);
  return b;
}

async function getTicketsForDraw(program, drawPda){
  const all = await program.account.ticket.all();
  return all.filter(r=>{
    const a = r.account||{};
    const d = a.draw||a.drawState||a.draw_state;
    return d && d.toBase58()===drawPda.toBase58();
  });
}

async function main(){
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new anchor.Program(IDL, provider);
  const conn = provider.connection;
  const wallet = provider.wallet.payer;

  const gs = PublicKey.findProgramAddressSync([Buffer.from("global-state-v3")], program.programId)[0];
  const va = PublicKey.findProgramAddressSync([Buffer.from("vault-authority-v3")], program.programId)[0];

  const g0 = await program.account.globalState.fetch(gs);
  const pv = pick(g0,"prizeVault","prize_vault");

  const vi = await getAccount(conn,pv);
  const mint = vi.mint;

  const currentDrawId = Number(pick(g0,"currentDrawId","current_draw_id")||0);
  const nextDrawId = new anchor.BN(currentDrawId+1);

  const drawPda = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), nextDrawId.toArrayLike(Buffer,"le",8)],
    program.programId
  )[0];

  step(1,"OPEN DRAW");

  const sigOpen = await program.methods
    .openDraw(new anchor.BN(60))
    .accounts({
      admin: wallet.publicKey,
      globalState: gs,
      drawState: drawPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await confirmTx(conn,sigOpen);

  step(2,"AUTO BUY");

  const userDrawState = PublicKey.findProgramAddressSync(
    [Buffer.from("user-draw"), drawPda.toBuffer(), wallet.publicKey.toBuffer()],
    program.programId
  )[0];

  const userAta = getAssociatedTokenAddressSync(mint,wallet.publicKey,false,TOKEN_PROGRAM_ID);

  const boughtTickets = [];

  for(let i=0;i<NUM_TICKETS;i++){
    const numbers=[1+i,2+i,3+i,4+i,5+i,6+i];
    const crypto=1+(i%10);

    const ticketPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("ticket"),
        drawPda.toBuffer(),
        wallet.publicKey.toBuffer(),
        u32le(i)
      ],
      program.programId
    )[0];

    const sigBuy = await program.methods
      .buyTicket(numbers,crypto)
      .accounts({
        user: wallet.publicKey,
        globalState: gs,
        drawState: drawPda,
        userDrawState,
        ticket: ticketPda,
        userTokenAccount: userAta,
        prizeVault: pv,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await confirmTx(conn,sigBuy);
    boughtTickets.push(ticketPda);
    log("BUY",`${i+1}/${NUM_TICKETS}`);
    await sleep(300);
  }

  step(3,"RANDOM");

  const kp = anchor.web3.Keypair.generate();

  await program.methods.requestRandomness()
    .accounts({ draw: drawPda, randomnessAccount: kp.publicKey })
    .rpc();

  const seed = Array.from({length:32},()=>Math.floor(Math.random()*256));

  await program.methods.fulfillRandomness(seed)
    .accounts({ admin: wallet.publicKey, globalState: gs, draw: drawPda })
    .rpc();

  step(4,"CLOSE");

  await program.methods.closeDraw()
    .accounts({
      globalState: gs,
      draw: drawPda,
      randomnessAccountData: kp.publicKey,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({units:400000})])
    .rpc();

  step(5,"SETTLE");

  const tickets = boughtTickets;

  if(tickets.length){
    const rem = tickets.map(pubkey=>({pubkey,isWritable:true,isSigner:false}));

    await program.methods.settleTickets(rem.length)
      .accounts({ draw: drawPda })
      .remainingAccounts(rem)
      .rpc();
  }

  step(6,"FINALIZE");

  await program.methods.finalizePayouts()
    .accounts({ globalState: gs, draw: drawPda })
    .rpc();

  step(7,"PAY / ZERO-WINNER FAST PATH");

  const dAfterFinalize = await program.account.draw.fetch(drawPda);
  const winnerCounts = pick(dAfterFinalize, "winnerCounts", "winner_counts") || [];
  const totalWinners = winnerCounts.reduce((a, b) => a + Number(b), 0);

  if (totalWinners === 0 && boughtTickets.length > 0) {
    await program.methods.payWinnersBatch(1)
      .accounts({
        draw: drawPda,
        ticket: boughtTickets[0],
        globalState: gs,
        prizeVault: pv,
        userTokenAccount: userAta,
        vaultAuthority: va,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    log("OK", "Zero-winner fast-path executed");
  }

  step(8,"FINAL REPORT");

  const dEnd = await program.account.draw.fetch(drawPda);

  console.log("");
  console.log("DRAW ID:", nextDrawId.toString());
  console.log("DRAW PDA:", drawPda.toBase58());
  console.log("STATUS:", String(dEnd.status));
  console.log("RESULT NUMBERS:", String(pick(dEnd, "resultNumbers", "result_numbers")));
  console.log("RESULT CRYPTO:", String(pick(dEnd, "resultCrypto", "result_crypto")));
  console.log("TICKETS SOLD:", String(pick(dEnd, "ticketsSold", "tickets_sold")));
  console.log("TICKETS PROCESSED:", String(pick(dEnd, "ticketsProcessed", "tickets_processed")));
  console.log("WINNER COUNTS:", String(pick(dEnd, "winnerCounts", "winner_counts")));
  console.log("PRIZE PER TIER:", String(pick(dEnd, "prizePerTier", "prize_per_tier")));
  console.log("TICKETS PAID:", String(pick(dEnd, "ticketsPaid", "tickets_paid")));
  console.log("IS PAID:", String(pick(dEnd, "isPaid", "is_paid")));
  console.log("EXPLORER:", `https://explorer.solana.com/address/${drawPda.toBase58()}?cluster=devnet`);
  console.log("");
}

main().catch(console.error);
