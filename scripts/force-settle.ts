import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Megabyt;

  const draw = new PublicKey("AJEXS89UY3nTub1mhuRDknSmuQ8rwJ73zyefUsLsmDUu");

  console.log("Fetching tickets...");

  const all = await program.account.ticket.all();

  const tickets = all.filter((t: any) => {
    try {
      const d = t.account.draw || t.account.drawState || t.account.draw_state;
      return d && d.toBase58() === draw.toBase58();
    } catch {
      return false;
    }
  });

  console.log("Tickets válidos:", tickets.length);

  const remainingAccounts = tickets.map((t: any) => ({
    pubkey: t.publicKey,
    isSigner: false,
    isWritable: true,
  }));

  console.log("Sending settle...");

  const tx = await program.methods
    .settleTickets(new anchor.BN(remainingAccounts.length))
    .accounts({ draw })
    .remainingAccounts(remainingAccounts)
    .rpc();

  console.log("SETTLE OK:", tx);
})();
