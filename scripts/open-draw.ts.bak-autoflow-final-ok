import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

(async function() {
  var provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  var program = (anchor.workspace as any).Megabyt;

  var globalStateRes = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")],
    program.programId
  );
  var globalState = globalStateRes[0];

  console.log("Program:     " + program.programId.toBase58());
  console.log("GlobalState: " + globalState.toBase58());
  console.log("");

  var globalData = await program.account.globalState.fetch(globalState);
  var currentId = Number(globalData.currentDrawId || globalData.current_draw_id || 0);
  var nextId = currentId + 1;

  var drawRes = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), new anchor.BN(nextId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  var drawState = drawRes[0];

  console.log("Current draw_id: " + currentId);
  console.log("Opening draw:    " + nextId);
  console.log("Draw PDA:        " + drawState.toBase58());
  console.log("");

  // 🔥 TEMPO DA DRAW (AJUSTE AQUI)
  var DURATION = Number(process.env.DURATION || 300); // 5 minutos para teste
  // var DURATION = 600;   // 10 minutos
  // var DURATION = 86400; // 24h produção

  var tx = await (program.methods
    .openDraw(new anchor.BN(DURATION))
    .accounts as any)({
      admin: provider.wallet.publicKey,
      globalState: globalState,
      drawState: drawState,
      systemProgram: SystemProgram.programId,
    }).rpc();

  var bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction(
    {
      signature: tx,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight
    },
    "confirmed"
  );

  console.log("DRAW ABERTA: " + tx);
  console.log("");

  var drawAccount = await program.account.draw.fetch(drawState);

  console.log("  id:          " + drawAccount.id);
  console.log("  status:      " + drawAccount.status);
  console.log("  isOpen:      " + drawAccount.isOpen);
  console.log("  ticketsSold: " + (drawAccount.ticketsSold || drawAccount.tickets_sold));
  console.log("");

  console.log("Done. Now buy tickets for this draw.");
})();


