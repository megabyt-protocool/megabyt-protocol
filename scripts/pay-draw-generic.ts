import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Megabyt } from "../target/types/megabyt";

const PAYOUT_BATCH_SIZE = Number(process.env.PAYOUT_BATCH_SIZE ?? "1");

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return null;
  return found.slice(prefix.length);
}

function readPubkey(value: string | null, label: string): PublicKey {
  if (!value) {
    throw new Error(`Missing ${label}. Use: --draw=<DRAW_PDA>`);
  }
  return new PublicKey(value);
}

function getNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value.toNumber === "function") return value.toNumber();
  return Number(value.toString());
}

function getBool(value: any): boolean {
  if (value === null || value === undefined) return false;
  return Boolean(value);
}

async function main() {
  console.log("============================================================");
  console.log("  MEGABYT — GENERIC PAY DRAW");
  console.log("============================================================");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;

  const drawPda = readPubkey(
    process.env.DRAW_PDA ?? getArg("draw"),
    "DRAW_PDA"
  );

  console.log("Program:", program.programId.toBase58());
  console.log("Wallet:", provider.wallet.publicKey.toBase58());
  console.log("Draw:", drawPda.toBase58());
  console.log("Batch size:", PAYOUT_BATCH_SIZE);

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")],
    program.programId
  );

  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority-v3")],
    program.programId
  );

  console.log("GlobalState:", globalState.toBase58());
  console.log("VaultAuthority:", vaultAuthority.toBase58());

  const globalStateAccount: any = await (program.account as any).globalState.fetch(
    globalState
  );

  const drawBefore: any = await (program.account as any).draw.fetch(drawPda);

  const prizeVault = new PublicKey(
    globalStateAccount.prizeVault ??
      globalStateAccount.prize_vault
  );

  const usdtMint = new PublicKey(
    globalStateAccount.usdtMint ??
      globalStateAccount.usdt_mint ??
      globalStateAccount.tokenMint ??
      globalStateAccount.token_mint
  );

  console.log("------------------------------------------------------------");
  console.log("Draw status before:", getNumber(drawBefore.status));
  console.log("Tickets sold:", getNumber(drawBefore.ticketsSold ?? drawBefore.tickets_sold));
  console.log("Tickets processed:", getNumber(drawBefore.ticketsProcessed ?? drawBefore.tickets_processed));
  console.log("Tickets paid:", getNumber(drawBefore.ticketsPaid ?? drawBefore.tickets_paid));
  console.log("isPaid:", getBool(drawBefore.isPaid ?? drawBefore.is_paid));
  console.log("Prize vault:", prizeVault.toBase58());
  console.log("Token mint:", usdtMint.toBase58());
  console.log("------------------------------------------------------------");

  const allTickets = await (program.account as any).ticket.all([
    {
      memcmp: {
        offset: 8 + 32,
        bytes: drawPda.toBase58(),
      },
    },
  ]);

  console.log("Tickets encontrados:", allTickets.length);

  const unpaidWinnerTickets = allTickets.filter((t: any) => {
    const prizeAmount = getNumber(t.account.prizeAmount ?? t.account.prize_amount);
    const paid = getBool(t.account.paid ?? t.account.isPaid ?? t.account.is_paid);
    return prizeAmount > 0 && !paid;
  });

  const zeroPrizeWinnerTickets = allTickets.filter((t: any) => {
    const tier = getNumber(t.account.tier);
    const prizeAmount = getNumber(t.account.prizeAmount ?? t.account.prize_amount);
    const paid = getBool(t.account.paid ?? t.account.isPaid ?? t.account.is_paid);
    return tier > 0 && prizeAmount === 0 && !paid;
  });

  console.log("Vencedores com prêmio pendente:", unpaidWinnerTickets.length);
  console.log("Vencedores com prêmio zero pendente:", zeroPrizeWinnerTickets.length);

  if (unpaidWinnerTickets.length === 0 && zeroPrizeWinnerTickets.length === 0) {
    console.log("Nenhum ticket vencedor pendente encontrado.");
  }

  let processedCount = 0;
  let paidCount = 0;

  const ticketsToProcess = [...unpaidWinnerTickets, ...zeroPrizeWinnerTickets];

  for (let i = 0; i < ticketsToProcess.length; i++) {
    const t: any = ticketsToProcess[i];

    const owner = new PublicKey(t.account.owner);
    const userTokenAccount = getAssociatedTokenAddressSync(usdtMint, owner);

    const prizeAmount = getNumber(t.account.prizeAmount ?? t.account.prize_amount);
    const tier = getNumber(t.account.tier);

    console.log("------------------------------------------------------------");
    console.log(`Processando ${i + 1}/${ticketsToProcess.length}`);
    console.log("Ticket:", t.publicKey.toBase58());
    console.log("Owner:", owner.toBase58());
    console.log("User ATA:", userTokenAccount.toBase58());
    console.log("Tier:", tier);
    console.log("Prize raw:", prizeAmount);

    try {
      const sig = await program.methods
        .payWinnersBatch(new BN(PAYOUT_BATCH_SIZE))
        .accounts({
          globalState,
          draw: drawPda,
          ticket: t.publicKey,
          prizeVault,
          vaultAuthority,
          userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      processedCount += 1;

      if (prizeAmount > 0) {
        paidCount += 1;
      }

      console.log("✔ OK:", sig);
    } catch (err: any) {
      console.error("✘ ERRO no ticket:", t.publicKey.toBase58());
      console.error(err?.message ?? err);
    }
  }

  const drawAfter: any = await (program.account as any).draw.fetch(drawPda);

  console.log("============================================================");
  console.log("  RESULTADO FINAL");
  console.log("============================================================");
  console.log("Tickets processados nesta execução:", processedCount);
  console.log("Tickets pagos com prêmio > 0:", paidCount);
  console.log("Status final:", getNumber(drawAfter.status));
  console.log("Tickets paid final:", getNumber(drawAfter.ticketsPaid ?? drawAfter.tickets_paid));
  console.log("isPaid final:", getBool(drawAfter.isPaid ?? drawAfter.is_paid));
  console.log("Explorer:");
  console.log(`https://explorer.solana.com/address/${drawPda.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
