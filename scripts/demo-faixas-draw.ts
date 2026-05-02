import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("2sq5GDjs2ESDEK2Jpec7je2aAnVJ2w7uZgM1Qh5GgpmS");
const GLOBAL_STATE = new PublicKey("AUJCkNYLRPLxBzrPZAjp64i22kcSFNh4aNJ5uiNNTiDv");

const CRYPTO_NAMES = ["BYTI","BTC","ETH","USDT","BNB","XRP","USDC","SOL","TRX","DOGE"];
const TIER_LABELS = ["6+crypto","6 nums","5+crypto","5 nums","4+crypto","4 nums","3+crypto","3 nums","2+crypto","2 nums"];

// GlobalState
const O_GS_CURRENT_DRAW = 208;

// Draw
const O_D_ID = 8;
const O_D_IS_CLOSED = 17;
const O_D_IS_PAID = 18;
const O_D_END_TIME = 28;
const O_D_POOL = 68;
const O_D_SOLD = 76;
const O_D_RESNUMS = 117;
const O_D_RESCRYP = 123;
const O_D_TICKETS_PROCESSED = 205;
const O_D_TICKETS_PAID = 213;
const O_D_WCOUNTS = 221;
const O_D_PTIER = 301;
const O_D_SETTLEMENT_COMPLETE = 381;
const O_D_STATUS = 382;

function rU64(b: Uint8Array, o: number): number {
  const lo = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const hi = (b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24)) >>> 0;
  return hi * 4294967296 + lo;
}

function wU64(v: number): Uint8Array {
  const b = new Uint8Array(8);
  const lo = v >>> 0;
  const hi = Math.floor(v / 4294967296) >>> 0;
  b[0] = lo & 0xff;
  b[1] = (lo >>> 8) & 0xff;
  b[2] = (lo >>> 16) & 0xff;
  b[3] = (lo >>> 24) & 0xff;
  b[4] = hi & 0xff;
  b[5] = (hi >>> 8) & 0xff;
  b[6] = (hi >>> 16) & 0xff;
  b[7] = (hi >>> 24) & 0xff;
  return b;
}

function fmt(raw: number): string {
  return (raw / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function fmtDate(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString("pt-BR");
}

function findDraw(drawId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("draw-v3"), Buffer.from(wU64(drawId))],
    PROGRAM_ID
  )[0];
}

async function loadCurrentDrawId(conn: Connection): Promise<number> {
  const info = await conn.getAccountInfo(GLOBAL_STATE, "confirmed");
  if (!info?.data) throw new Error("GlobalState não encontrada");
  return rU64(new Uint8Array(info.data), O_GS_CURRENT_DRAW);
}

async function loadDraw(conn: Connection, drawId: number) {
  const pda = findDraw(drawId);
  const info = await conn.getAccountInfo(pda, "confirmed");
  if (!info?.data) return null;

  const raw = new Uint8Array(info.data);

  const resultNumbers: number[] = [];
  for (let i = 0; i < 6; i++) resultNumbers.push(raw[O_D_RESNUMS + i]);

  const winnerCounts: number[] = [];
  for (let i = 0; i < 10; i++) winnerCounts.push(rU64(raw, O_D_WCOUNTS + i * 8));

  const prizePerTier: number[] = [];
  for (let i = 0; i < 10; i++) prizePerTier.push(rU64(raw, O_D_PTIER + i * 8));

  return {
    drawId: rU64(raw, O_D_ID),
    pda,
    isClosed: raw[O_D_IS_CLOSED] === 1,
    isPaid: raw[O_D_IS_PAID] === 1,
    settlementComplete: raw[O_D_SETTLEMENT_COMPLETE] === 1,
    status: raw[O_D_STATUS],
    endTime: rU64(raw, O_D_END_TIME),
    pool: rU64(raw, O_D_POOL),
    sold: rU64(raw, O_D_SOLD),
    processed: rU64(raw, O_D_TICKETS_PROCESSED),
    paid: rU64(raw, O_D_TICKETS_PAID),
    resultNumbers,
    resultCrypto: raw[O_D_RESCRYP],
    winnerCounts,
    prizePerTier,
  };
}

async function findLatestClosedDraw(conn: Connection, startDrawId: number) {
  for (let id = startDrawId; id >= Math.max(1, startDrawId - 80); id--) {
    const draw = await loadDraw(conn, id);
    if (!draw) continue;
    const hasResult = draw.resultNumbers.some((n) => n > 0) && draw.resultCrypto > 0;
    if (draw.isClosed && hasResult) return draw;
  }
  throw new Error("Nenhuma draw fechada com resultado encontrada");
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const requestedDrawId = process.env.DRAW_ID ? Number(process.env.DRAW_ID) : 0;

  const currentDrawId = await loadCurrentDrawId(conn);
  const draw = requestedDrawId > 0
    ? await loadDraw(conn, requestedDrawId)
    : await findLatestClosedDraw(conn, currentDrawId);

  if (!draw) throw new Error("Draw não encontrada");

  console.log("==============================================================");
  console.log("  MEGABYT — FAIXAS / ACERTADORES / PRÊMIO POR FAIXA");
  console.log("==============================================================");
  console.log("");
  console.log("Draw ID:              ", draw.drawId);
  console.log("Draw PDA:             ", draw.pda.toBase58());
  console.log("Encerrada em:         ", fmtDate(draw.endTime));
  console.log("Status:               ", draw.status);
  console.log("Is Closed:            ", draw.isClosed);
  console.log("Settlement Complete:  ", draw.settlementComplete);
  console.log("Is Paid:              ", draw.isPaid);
  console.log("Tickets Sold:         ", draw.sold);
  console.log("Tickets Processed:    ", draw.processed);
  console.log("Tickets Paid:         ", draw.paid);
  console.log("Prize Pool:           ", fmt(draw.pool), "BYT$");
  console.log("Resultado:            ", draw.resultNumbers.join(", "));
  console.log("Crypto:               ", `${CRYPTO_NAMES[draw.resultCrypto - 1] || draw.resultCrypto} (#${draw.resultCrypto})`);
  console.log("");

  console.log("--------------------------------------------------------------");
  console.log("FAIXA                 | ACERTADORES | PRÊMIO CADA | TOTAL FAIXA");
  console.log("--------------------------------------------------------------");

  let totalWinners = 0;
  let totalPaidRaw = 0;

  for (let i = 0; i < 10; i++) {
    const winners = draw.winnerCounts[i];
    const eachPrize = draw.prizePerTier[i];
    const totalTier = winners * eachPrize;

    totalWinners += winners;
    totalPaidRaw += totalTier;

    const faixa = TIER_LABELS[i].padEnd(21, " ");
    const w = String(winners).padStart(11, " ");
    const ep = fmt(eachPrize).padStart(11, " ");
    const tt = fmt(totalTier).padStart(11, " ");

    console.log(`${faixa} | ${w} | ${ep} | ${tt}`);
  }

  console.log("--------------------------------------------------------------");
  console.log("Total Winners:        ", totalWinners);
  console.log("Total Paid (sum):     ", fmt(totalPaidRaw), "BYT$");
  console.log("==============================================================");
}

main().catch((err) => {
  console.error("");
  console.error("ERRO:", err?.message || err);
  process.exit(1);
});
