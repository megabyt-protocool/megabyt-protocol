import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const IDL = require("../target/idl/megabyt.json");

function pick(obj: any, ...keys: string[]) {
  for (const k of keys) {
    if (obj && typeof obj[k] !== "undefined") return obj[k];
  }
  return undefined;
}

function toNum(v: any): number {
  if (typeof v === "number") return v;
  if (v && typeof v.toNumber === "function") return v.toNumber();
  return Number(v ?? 0);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new anchor.Program(IDL as any, provider);
  const connection = provider.connection;

  const drawPubkey = new PublicKey("6pKZkaeq8ZhZoY42XWr3uVPyD17FvFiT1aUbznzqg4RR");

  console.log("Checking draw:", drawPubkey.toBase58());

  const draw: any = await (program.account as any).draw.fetch(drawPubkey);

  const resultNumbers = pick(draw, "resultNumbers", "result_numbers");
  const resultCrypto = pick(draw, "resultCrypto", "result_crypto");
  const winnerCounts = pick(draw, "winnerCounts", "winner_counts");
  const prizePerTier = pick(draw, "prizePerTier", "prize_per_tier");

  console.log("\n=== DRAW RESULT ===");
  console.log("Numbers:", resultNumbers.join(","));
  console.log("Crypto:", resultCrypto);
  console.log("WinnerCounts:", winnerCounts.map((x: any) => toNum(x)).join(","));
  console.log("PrizePerTier:", prizePerTier.map((x: any) => toNum(x)).join(","));

  const tickets = await connection.getProgramAccounts(program.programId, {
    filters: [
      {
        memcmp: {
          offset: 8 + 32,
          bytes: drawPubkey.toBase58(),
        },
      },
    ],
  });

  console.log("\nTickets found:", tickets.length);

  const coder = new anchor.BorshAccountsCoder(IDL);
  let foundWinner = false;

  for (let i = 0; i < tickets.length; i++) {
    const acc = tickets[i];
    const decoded: any = coder.decode("Ticket", acc.account.data);

    const numbers = pick(decoded, "numbers");
    const crypto = pick(decoded, "crypto", "crypto_number");
    const tier = toNum(pick(decoded, "tier"));
    const prizeAmount = toNum(pick(decoded, "prizeAmount", "prize_amount"));
    const paid = !!pick(decoded, "paid");
    const settled = !!pick(decoded, "settled");
    const owner = pick(decoded, "owner");

    if (tier > 0 || prizeAmount > 0 || paid) {
      foundWinner = true;
      console.log("\n=== WINNING / PAID TICKET ===");
      console.log("Ticket PDA:", acc.pubkey.toBase58());
      console.log("Owner:", owner.toBase58 ? owner.toBase58() : String(owner));
      console.log("Numbers:", numbers.join(","));
      console.log("Crypto:", crypto);
      console.log("Tier:", tier);
      console.log("PrizeAmount:", prizeAmount);
      console.log("Settled:", settled);
      console.log("Paid:", paid);
    }
  }

  if (!foundWinner) {
    console.log("\nNo winning ticket found with tier/prize/paid > 0.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

