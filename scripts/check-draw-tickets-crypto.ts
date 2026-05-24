import * as anchor from "@coral-xyz/anchor";

const CRYPTO_NAMES = ["BYT$","BTC","ETH","USDT","BNB","XRP","USDC","SOL","TRX","DOGE"];

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as anchor.Program;

  const drawIds = [218, 219];

  const tickets = await program.account.ticket.all();

  for (const drawId of drawIds) {
    const [drawPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("draw-v3"), new anchor.BN(drawId).toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const filtered = tickets.filter((t: any) => {
      const a: any = t.account;
      return a.draw?.toBase58?.() === drawPda.toBase58() || a.drawState?.toBase58?.() === drawPda.toBase58();
    });

    console.log("\n==============================");
    console.log("DRAW", drawId, drawPda.toBase58());
    console.log("tickets found:", filtered.length);

    filtered.slice(0, 20).forEach((t: any, i: number) => {
      const a: any = t.account;
      const nums = Array.from(a.numbers || []);
      const c = Number(a.crypto ?? a.cryptoPrediction ?? a.cryptoNumber ?? 0);
      console.log(`#${i}`, t.publicKey.toBase58());
      console.log("numbers:", nums.join(", "));
      console.log("crypto:", c, CRYPTO_NAMES[c - 1] || "INVALID");
    });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
