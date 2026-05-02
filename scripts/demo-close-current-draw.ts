import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(obj: any, ...keys: string[]) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function randomSeed32(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) out.push(Math.floor(Math.random() * 256));
  return out;
}

function findAta(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

function asPubkey(v: any): PublicKey {
  if (v instanceof PublicKey) return v;
  return new PublicKey(v.toString());
}

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = (anchor.workspace as any).Megabyt as Program<any>;
  const wallet = provider.wallet as any;

  console.log("");
  console.log("==============================================");
  console.log("  MEGABYT — AUTO CLOSE / SETTLE / PAY");
  console.log("==============================================");
  console.log("");

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")],
    program.programId
  );

  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority-v3")],
    program.programId
  );

  const globalData = await program.account.globalState.fetch(globalState);
  const drawId = Number(pick(globalData, "currentDrawId", "current_draw_id"));

  const prizeVault = asPubkey(pick(globalData, "prizeVault", "prize_vault"));

  const prizeVaultInfo = await provider.connection.getParsedAccountInfo(prizeVault);
  const parsed: any = prizeVaultInfo.value?.data;
  const prizeVaultMint = new PublicKey(parsed.parsed.info.mint);

  const [drawPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("draw-v3"),
      new anchor.BN(drawId).toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  console.log("Program:", program.programId.toBase58());
  console.log("GlobalState:", globalState.toBase58());
  console.log("Draw ID:", drawId);
  console.log("Draw PDA:", drawPda.toBase58());
  console.log("Prize Vault:", prizeVault.toBase58());
  console.log("Prize Vault Mint:", prizeVaultMint.toBase58());
  console.log("Vault Authority:", vaultAuthority.toBase58());
  console.log("");

  let draw = await program.account.draw.fetch(drawPda);

  let isClosed = !!pick(draw, "isClosed", "is_closed");
  let randomnessRequested = !!pick(draw, "randomnessRequested", "randomness_requested");
  let randomnessFulfilled = !!pick(draw, "randomnessFulfilled", "randomness_fulfilled");
  let settlementComplete = !!pick(draw, "settlementComplete", "settlement_complete");
  let isPaid = !!pick(draw, "isPaid", "is_paid");
  let status = Number(pick(draw, "status"));

  console.log("Initial status:", status);
  console.log("isClosed:", isClosed);
  console.log("randomnessRequested:", randomnessRequested);
  console.log("randomnessFulfilled:", randomnessFulfilled);
  console.log("settlementComplete:", settlementComplete);
  console.log("isPaid:", isPaid);
  console.log("");

  const randomnessKp = Keypair.generate();

  if (!randomnessRequested) {
    console.log("REQUEST RANDOMNESS...");

    await program.methods
      .requestRandomness()
      .accounts({
        draw: drawPda,
        randomnessAccount: randomnessKp.publicKey,
      })
      .rpc();

    console.log("OK request_randomness");
    await sleep(1000);
  } else {
    console.log("SKIP request_randomness — already requested");
  }

  draw = await program.account.draw.fetch(drawPda);
  randomnessFulfilled = !!pick(draw, "randomnessFulfilled", "randomness_fulfilled");

  if (!randomnessFulfilled) {
    console.log("FULFILL RANDOMNESS...");

    const seed = randomSeed32();

    await program.methods
      .fulfillRandomness(seed)
      .accounts({
        admin: wallet.publicKey,
        globalState,
        draw: drawPda,
      })
      .rpc();

    console.log("OK fulfill_randomness");
    await sleep(1000);
  } else {
    console.log("SKIP fulfill_randomness — already fulfilled");
  }

  draw = await program.account.draw.fetch(drawPda);
  isClosed = !!pick(draw, "isClosed", "is_closed");

  if (!isClosed) {
    console.log("CLOSE DRAW...");

    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });

    await program.methods
      .closeDraw()
      .accounts({
        globalState,
        draw: drawPda,
        randomnessAccountData: randomnessKp.publicKey,
      })
      .preInstructions([cuIx])
      .rpc();

    console.log("OK close_draw");
    await sleep(1500);
  } else {
    console.log("SKIP close_draw — already closed");
  }

  draw = await program.account.draw.fetch(drawPda);

  console.log("");
  console.log("RESULT:");
  console.log("Numbers:", pick(draw, "resultNumbers", "result_numbers"));
  console.log("Crypto:", pick(draw, "resultCrypto", "result_crypto"));
  console.log("");

  settlementComplete = !!pick(draw, "settlementComplete", "settlement_complete");
  status = Number(pick(draw, "status"));

  if (!settlementComplete && (status === 1 || status === 2)) {
    console.log("SETTLE...");

    const tickets = await program.account.ticket.all([
      {
        memcmp: {
          offset: 40,
          bytes: drawPda.toBase58(),
        },
      },
    ]);

    let offset = 0;
    while (offset < tickets.length) {
      const batch = tickets.slice(offset, offset + 20);

      const rem = batch.map((t: any) => ({
        pubkey: t.publicKey,
        isWritable: true,
        isSigner: false,
      }));

      if (rem.length > 0) {
        await program.methods
          .settleTickets(new BN(rem.length))
          .accounts({ draw: drawPda })
          .remainingAccounts(rem)
          .rpc();
      }

      offset += rem.length;
      console.log("Settled:", offset, "/", tickets.length);
      await sleep(300);
    }
  } else {
    console.log("SKIP settle — already complete or status not settle-ready");
  }

  draw = await program.account.draw.fetch(drawPda);
  settlementComplete = !!pick(draw, "settlementComplete", "settlement_complete");
  isPaid = !!pick(draw, "isPaid", "is_paid");

  if (settlementComplete && !isPaid) {
    console.log("FINALIZE...");

    try {
      await program.methods
        .finalizePayouts()
        .accounts({
          globalState,
          draw: drawPda,
        })
        .rpc();

      console.log("OK finalize");
      await sleep(1000);
    } catch (e: any) {
      console.log("SKIP/ERROR finalize:", e.message || String(e));
    }
  } else {
    console.log("SKIP finalize — settlement not complete or already paid/finalized");
  }

  draw = await program.account.draw.fetch(drawPda);
  isPaid = !!pick(draw, "isPaid", "is_paid");

  console.log("");
  console.log("PAY WINNERS...");

  const allTickets = await program.account.ticket.all([
    {
      memcmp: {
        offset: 40,
        bytes: drawPda.toBase58(),
      },
    },
  ]);

  let paidNow = 0;
  let skipped = 0;
  let errors = 0;

  for (const t of allTickets) {
    try {
      const tier = Number(pick(t.account, "tier"));
      const paid = !!pick(t.account, "paid");
      const owner = asPubkey(pick(t.account, "owner"));

      if (paid || tier > 9) {
        skipped++;
        continue;
      }

      const userTokenAccount = findAta(prizeVaultMint, owner);

      await program.methods
        .payWinnersBatch(new BN(1))
        .accounts({
          draw: drawPda,
          ticket: t.publicKey,
          globalState,
          prizeVault,
          userTokenAccount,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      paidNow++;
      console.log("Paid:", t.publicKey.toBase58(), "tier:", tier);
      await sleep(250);
    } catch (e: any) {
      errors++;
      console.log("Payment skip/error:", t.publicKey.toBase58(), "-", e.message || String(e));
    }
  }

  draw = await program.account.draw.fetch(drawPda);

  console.log("");
  console.log("==============================================");
  console.log("  FINAL REPORT");
  console.log("==============================================");
  console.log("Draw ID:", drawId);
  console.log("Status:", pick(draw, "status"));
  console.log("isClosed:", pick(draw, "isClosed", "is_closed"));
  console.log("settlementComplete:", pick(draw, "settlementComplete", "settlement_complete"));
  console.log("isPaid:", pick(draw, "isPaid", "is_paid"));
  console.log("ticketsSold:", String(pick(draw, "ticketsSold", "tickets_sold")));
  console.log("ticketsProcessed:", String(pick(draw, "ticketsProcessed", "tickets_processed")));
  console.log("ticketsPaid:", String(pick(draw, "ticketsPaid", "tickets_paid")));
  console.log("paidNow:", paidNow);
  console.log("skipped:", skipped);
  console.log("errors:", errors);
  console.log("resultNumbers:", pick(draw, "resultNumbers", "result_numbers"));
  console.log("resultCrypto:", pick(draw, "resultCrypto", "result_crypto"));
  console.log("==============================================");
})();
