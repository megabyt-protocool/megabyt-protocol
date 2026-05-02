import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

(async function() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = (anchor.workspace as any).Megabyt;

  const drawPda = new PublicKey("EwMdzD41EJfaag7VpyPRHvUBZihuXCC7qq8CuSp28tU6");

  console.log("Program:", program.programId.toBase58());
  console.log("Draw:", drawPda.toBase58());
  console.log("");

  const drawData = await program.account.draw.fetch(drawPda);
  console.log("Draw status:", drawData.status);
  console.log(
    "Draw tickets_sold:",
    (drawData.ticketsSold || drawData.tickets_sold).toString()
  );
  console.log(
    "Draw tickets_processed:",
    (drawData.ticketsProcessed || drawData.tickets_processed).toString()
  );
  console.log("Draw settled:", drawData.settled);
  console.log("");

  console.log("Fetching all tickets...");
  const allTickets = await program.account.ticket.all();
  console.log("Total tickets on-chain:", allTickets.length);

  const drawTickets: Array<{ publicKey: PublicKey; account: any }> = [];
  for (const t of allTickets) {
    if (!t || !t.account) continue;
    const dk = t.account.draw || t.account.drawState || t.account.draw_state;
    const pk = t.publicKey || t.pubkey;
    if (dk && pk && typeof dk.toBase58 === "function" && dk.toBase58() === drawPda.toBase58()) {
      drawTickets.push({ publicKey: pk, account: t.account });
    }
  }

  console.log("Tickets for Draw 6:", drawTickets.length);

  if (drawTickets.length === 0) {
    console.error("No tickets found for this draw. Aborting.");
    process.exit(1);
  }

  let unsettled = 0;
  for (const t of drawTickets) {
    if (!t.account.settled) unsettled++;
  }
  console.log("Unsettled tickets:", unsettled);
  console.log("");

  if (unsettled === 0) {
    console.log("All tickets already settled. Nothing to do.");
    process.exit(0);
  }

  const remaining: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> = [];
  for (const t of drawTickets) {
    if (!t.account.settled) {
      remaining.push({
        pubkey: t.publicKey,
        isWritable: true,
        isSigner: false,
      });
    }
  }

  console.log("Sending settleTickets with batch_size=300, remainingAccounts=" + remaining.length);
  console.log("");

  const tx = await (program.methods.settleTickets(300) as any)
    .accounts({ draw: drawPda })
    .remainingAccounts(remaining)
    .rpc();

  console.log("TX:", tx);
  console.log("");

  const after = await program.account.draw.fetch(drawPda);
  console.log("After settle:");
  console.log("  status:", after.status);
  console.log(
    "  tickets_processed:",
    (after.ticketsProcessed || after.tickets_processed).toString()
  );
  console.log("  settlement_complete:", after.settlementComplete || after.settlement_complete);
  console.log("  settled:", after.settled);
  console.log("  winner_counts:", String(after.winnerCounts || after.winner_counts));
  console.log("");
  console.log("Done.");
})().catch((err) => {
  console.error("SETTLE SCRIPT ERROR:", err);
  process.exit(1);
});
