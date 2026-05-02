import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Megabyt } from "../target/types/megabyt";

const BATCH_SIZE = 1;

function getNumber(v: any): number {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v.toNumber) return v.toNumber();
  return Number(v.toString());
}

function getBool(v: any): boolean {
  return Boolean(v);
}

async function main() {
  console.log("========================================");
  console.log("  PAY CURRENT DRAW (AUTO)");
  console.log("========================================");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")],
    program.programId
  );

  const global: any = await (program.account as any).globalState.fetch(globalState);

  const drawId = getNumber(global.currentDrawId ?? global.current_draw_id);

  const [drawPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), new BN(drawId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority-v3")],
    program.programId
  );

  const prizeVault = new PublicKey(
    global.prizeVault ?? global.prize_vault
  );

  const usdtMint = new PublicKey(
    global.usdtMint ?? global.usdt_mint
  );

  console.log("Draw ID:", drawId);
  console.log("Draw PDA:", drawPda.toBase58());

  let loop = 0;

  while (true) {
    loop++;

    const draw: any = await (program.account as any).draw.fetch(drawPda);

    const ticketsPaid = getNumber(draw.ticketsPaid ?? draw.tickets_paid);
    const isPaid = getBool(draw.isPaid ?? draw.is_paid);

    console.log(`\nLoop ${loop}`);
    console.log("Tickets paid:", ticketsPaid, "| isPaid:", isPaid);

    if (isPaid) {
      console.log("✔ Tudo pago. Finalizando.");
      break;
    }

    const allTickets = await (program.account as any).ticket.all([
      {
        memcmp: {
          offset: 8 + 32,
          bytes: drawPda.toBase58(),
        },
      },
    ]);

    const pending = allTickets.filter((t: any) => {
      const prize = getNumber(t.account.prizeAmount ?? t.account.prize_amount);
      const paid = getBool(t.account.paid ?? t.account.is_paid);
      return prize > 0 && !paid;
    });

    console.log("Pendentes:", pending.length);

    if (pending.length === 0) {
      console.log("Nenhum ticket pendente.");
      break;
    }

    for (const t of pending) {
      const owner = new PublicKey(t.account.owner);
      const userAta = getAssociatedTokenAddressSync(usdtMint, owner);

      try {
        const sig = await program.methods
          .payWinnersBatch(new BN(BATCH_SIZE))
          .accounts({
            globalState,
            draw: drawPda,
            ticket: t.publicKey,
            prizeVault,
            vaultAuthority,
            userTokenAccount: userAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        console.log("✔ Pago:", t.publicKey.toBase58(), sig);
      } catch (e: any) {
        console.log("Erro:", e.message);
      }
    }
  }

  console.log("\nFINALIZADO");
}

main();
