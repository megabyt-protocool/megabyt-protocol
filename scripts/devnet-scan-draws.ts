/**
 * Read-only: inspeciona Draw accounts da devnet (por id, resiliente a decode).
 *   ANCHOR_PROVIDER_URL=<helius> ANCHOR_WALLET=~/.config/solana/id.json \
 *   FROM=270 TO=292 npx ts-node scripts/devnet-scan-draws.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";

const IDL = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/megabyt.json", "utf8"));

(async function () {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL as anchor.Idl, provider);
  const conn = provider.connection;
  const pid = program.programId;

  const from = Number(process.env.FROM || "270");
  const to = Number(process.env.TO || "292");

  const bn = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);
  const drawPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), bn(id)], pid)[0];

  console.log("id   | len  | status | tkts_sold | processed | paid | is_closed | settled | is_paid | real_tickets");
  console.log("-----+------+--------+-----------+-----------+------+-----------+---------+---------+-------------");

  for (let id = from; id <= to; id++) {
    const info = await conn.getAccountInfo(drawPda(id));
    if (!info) { console.log(`${String(id).padStart(4)} | (ausente)`); continue; }
    const d = info.data;
    // campos de offset fixo (antes das Vecs)
    const tsold = d.readBigUInt64LE(76);
    const isClosed = d[17], isPaid = d[18], settled = d[19];
    // status: cauda = ... settlement_complete(1) status(1) bump(1) monthly_rollover(8) numbers_count(1)
    const status = d[d.length - 11];

    // tickets reais on-chain dessa draw: memcmp em draw_id no offset 8+32+32=72
    let real = "?";
    try {
      const accs = await conn.getProgramAccounts(pid, {
        filters: [{ memcmp: { offset: 72, bytes: anchor.utils.bytes.bs58.encode(bn(id)) } }],
        dataSlice: { offset: 0, length: 0 },
      });
      // filtra só os que são realmente Ticket (tamanho plausível) — getPA sem disc pode pegar outros; medimos depois
      real = String(accs.length);
    } catch (e: any) { real = "err"; }

    console.log([
      String(id).padStart(4),
      String(d.length).padStart(4),
      String(status).padStart(6),
      String(Number(tsold)).padStart(9),
      "        -",
      "   -",
      String(isClosed).padStart(9),
      String(settled).padStart(7),
      String(isPaid).padStart(7),
      real.padStart(12),
    ].join(" | "));
  }
})().catch((e) => { console.error("ERRO:", e.message || e); process.exit(1); });
