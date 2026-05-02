import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

const DRAW = new PublicKey("BBCA6i3XP9srRYWeqfpqUB8SZp2yJemDjfeToxSHzM9Q");

async function main() {
  console.log("=== SETTLE DRAW 12 ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const connection = provider.connection;

  console.log("Buscando tickets...");

  const tickets = await connection.getProgramAccounts(program.programId, {
    filters: [
      {
        memcmp: {
          offset: 8 + 32, // discriminator + owner
          bytes: DRAW.toBase58(),
        },
      },
    ],
  });

  console.log(`Total tickets encontrados: ${tickets.length}`);

  for (let i = 0; i < tickets.length; i++) {
    const ticketPubkey = tickets[i].pubkey;

    try {
      await program.methods
        .settleTickets(new anchor.BN(1))
        .accounts({
          draw: DRAW,
          ticket: ticketPubkey,
        })
        .rpc();

      console.log(`✔ Ticket ${i + 1}/${tickets.length}`);
    } catch (e) {
      console.log(`Erro no ticket ${i}:`, e.message);
    }
  }

  console.log("Settlement finalizado");

  const draw = await program.account.draw.fetch(DRAW);

  console.log("=== STATUS FINAL ===");
  console.log("processed:", Number(draw.ticketsProcessed));
  console.log("sold:", Number(draw.ticketsSold));
  console.log("complete:", draw.settlementComplete);
}

main().catch(console.error);

