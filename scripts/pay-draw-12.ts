import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Megabyt } from "../target/types/megabyt";

const DRAW = new PublicKey("BBCA6i3XP9srRYWeqfpqUB8SZp2yJemDjfeToxSHzM9Q");
const PAYOUT_BATCH_SIZE = 1;

async function main() {
  console.log("=== PAY DRAW 12 ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state")],
    program.programId
  );

  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority")],
    program.programId
  );

  const globalStateAccount: any = await (program.account as any).globalState.fetch(globalState);
  const drawAccountBefore: any = await (program.account as any).draw.fetch(DRAW);

  const prizeVault = new PublicKey(
    globalStateAccount.prizeVault ?? globalStateAccount.prize_vault
  );

  const usdtMint = new PublicKey(
    globalStateAccount.usdtMint ??
      globalStateAccount.usdt_mint ??
      globalStateAccount.tokenMint ??
      globalStateAccount.token_mint
  );

  console.log("Status draw:", Number(drawAccountBefore.status));
  console.log("Prize vault:", prizeVault.toBase58());
  console.log("USDT mint:", usdtMint.toBase58());

  const allTickets = await (program.account as any).ticket.all([
    {
      memcmp: {
        offset: 8 + 32, // discriminator + owner; próximo campo é draw
        bytes: DRAW.toBase58(),
      },
    },
  ]);

  console.log("Tickets encontrados:", allTickets.length);

  const winnerTickets = allTickets.filter((t: any) => {
    const prizeAmount = Number(t.account.prizeAmount ?? t.account.prize_amount ?? 0);
    const paid = Boolean(t.account.paid ?? false);
    return prizeAmount > 0 && !paid;
  });

  console.log("Tickets vencedores não pagos:", winnerTickets.length);

  let paidCount = 0;

  for (let i = 0; i < winnerTickets.length; i++) {
    const t: any = winnerTickets[i];

    const owner = new PublicKey(t.account.owner);
    const userTokenAccount = getAssociatedTokenAddressSync(usdtMint, owner);

    const prizeAmount = Number(t.account.prizeAmount ?? t.account.prize_amount ?? 0);
    const tier = Number(t.account.tier);

    console.log(
      `Pagando ${i + 1}/${winnerTickets.length} | ticket=${t.publicKey.toBase58()} | owner=${owner.toBase58()} | tier=${tier} | prize=${prizeAmount}`
    );

    try {
      await program.methods
        .payWinnersBatch(new BN(PAYOUT_BATCH_SIZE))
        .accounts({
          globalState,
          draw: DRAW,
          ticket: t.publicKey,
          prizeVault,
          vaultAuthority,
          userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      paidCount += 1;
      console.log(`✔ Pago ${paidCount}/${winnerTickets.length}`);
    } catch (err) {
      console.error(`✘ Erro ao pagar ticket ${t.publicKey.toBase58()}:`, err);
    }
  }

  const drawAfter: any = await (program.account as any).draw.fetch(DRAW);

  console.log("=== RESULTADO FINAL ===");
  console.log("Pagos nesta execução:", paidCount);
  console.log("Status final draw:", Number(drawAfter.status));
  console.log("isPaid final:", Boolean(drawAfter.isPaid ?? drawAfter.is_paid ?? false));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

