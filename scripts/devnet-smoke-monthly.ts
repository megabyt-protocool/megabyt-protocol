/**
 * SMOKE TEST do ciclo mensal na devnet — fase por fase.
 *   ANCHOR_PROVIDER_URL=<helius> ANCHOR_WALLET=~/.config/solana/id.json \
 *   PHASE=setup|open|close|settle|finalize|pay|check \
 *   npx ts-node scripts/devnet-smoke-monthly.ts
 *
 * Range [286, 287], 4 tickets, 1 vencedor tier 3 (cenário a).
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";

const IDL = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/megabyt.json", "utf8"));

const RESULT = [5, 17, 27, 32, 51, 57]; // seed determinístico [1..32], numbers_count=6
const CRYPTO = 9;
const BPS = [1200n, 800n, 600n, 500n, 400n, 300n, 300n, 250n, 150n];
const BPS_SUM = 4500n;
const MIN_PRIZE = 1_000_000n;

const DRAW_A = 286, DRAW_B = 287;
const TICKETS: { draw: number; idx: number; numbers: number[]; crypto: number; label: string }[] = [
  { draw: DRAW_A, idx: 0, numbers: [5, 17, 27, 32, 51, 58], crypto: 3, label: "T0 tier3-winner" },
  { draw: DRAW_A, idx: 1, numbers: [1, 2, 3, 4, 6, 7], crypto: 1, label: "T1 loser" },
  { draw: DRAW_A, idx: 2, numbers: [8, 9, 10, 11, 12, 13], crypto: 2, label: "T2 loser" },
  { draw: DRAW_B, idx: 0, numbers: [14, 15, 16, 18, 19, 20], crypto: 1, label: "T3 loser" },
];

function countHits(nums: number[]) { return nums.filter((n) => RESULT.includes(n)).length; }
function expectedTier(nums: number[], crypto: number) {
  const hits = countHits(nums);
  const deficit = 6 - hits;
  if (deficit > 4) return 255;
  const base = deficit * 2;
  return crypto === CRYPTO ? base : base + 1;
}

// ---- decoders manuais (o client anchor 0.32.1 quebra em campos `bytes`) ----
function decDraw(d: Buffer) {
  return {
    id: d.readBigUInt64LE(8),
    ticketsSold: d.readBigUInt64LE(76),
    status: d[d.length - 11],
    isClosed: d[17],
  };
}
function decMonthlyDraw(d: Buffer) {
  const L = d.length;
  const nlen = d.readUInt32LE(81);
  const resultNumbers = [...d.subarray(85, 85 + nlen)];
  const resultCrypto = d[85 + nlen];
  const winnerCounts: bigint[] = [];
  const prizePerTier: bigint[] = [];
  const wcOff = L - 179, ptOff = L - 99;
  for (let i = 0; i < 10; i++) winnerCounts.push(d.readBigUInt64LE(wcOff + i * 8));
  for (let i = 0; i < 10; i++) prizePerTier.push(d.readBigUInt64LE(ptOff + i * 8));
  return {
    id: d.readBigUInt64LE(8),
    firstDrawId: d.readBigUInt64LE(16),
    lastDrawId: d.readBigUInt64LE(24),
    ticketsTarget: d.readBigUInt64LE(32),
    ticketsProcessed: d.readBigUInt64LE(40),
    ticketsPaid: d.readBigUInt64LE(48),
    poolSnapshot: d.readBigUInt64LE(56),
    jackpotPool: d.readBigUInt64LE(64),
    cascadePool: d.readBigUInt64LE(72),
    resultNumbers, resultCrypto,
    winnerCounts, prizePerTier,
    jackpotHit: d[L - 19] !== 0,
    jackpotWinnerCount: d.readBigUInt64LE(L - 18),
    rolloverToNextMonth: d.readBigUInt64LE(L - 10),
    status: d[L - 2],
  };
}
function decMonthlyState(d: Buffer) {
  return {
    monthlyVault: new PublicKey(d.subarray(8, 40)),
    currentMonthlyId: d.readBigUInt64LE(40),
    totalMonthlyDraws: d.readBigUInt64LE(48),
    jackpotCarry: d.readBigUInt64LE(56),
    lastCoveredDrawId: d.readBigUInt64LE(72),
  };
}
function decGlobalMonthlyPool(d: Buffer) { return d.readBigUInt64LE(714); }
function tokAmount(d: Buffer) { return d.readBigUInt64LE(64); }

(async function () {
  const phase = process.env.PHASE || "";
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL as anchor.Idl, provider);
  const conn = provider.connection;
  const pid = program.programId;
  const admin = provider.wallet.publicKey;
  const M = (program.methods as any);

  const P1 = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s)], pid)[0];
  const globalState = P1("global-state-v3");
  const monthlyState = P1("monthly-state-v3");
  const monthlyVault = P1("monthly-vault-v3");
  const vaultAuthority = P1("vault-authority-v3");
  const prizeVault = new PublicKey("8sEKCpLjLLZzRjwKXfn5ubYhuJu2jdYFa5ngqbTyw7mz");
  const adminAta = new PublicKey("Gh8iKdUwXmHEaFqKMErLyicU57NyPb9QqUw1yWxForKS");
  const u64 = (n: number | bigint) => new anchor.BN(n.toString());
  const leU64 = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);
  const leU32 = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 4);
  const drawPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), leU64(id)], pid)[0];
  const monthlyDrawPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("monthly-draw-v3"), leU64(id)], pid)[0];
  const ticketPda = (draw: number, idx: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("ticket"), drawPda(draw).toBuffer(), admin.toBuffer(), leU32(idx)], pid)[0];
  const userDrawPda = (draw: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("user-draw"), drawPda(draw).toBuffer(), admin.toBuffer()], pid)[0];
  const userGlobalPda = () => PublicKey.findProgramAddressSync([Buffer.from("user-global-v3"), admin.toBuffer()], pid)[0];
  const claimPda = (mDraw: PublicKey, tkt: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("m-claim"), mDraw.toBuffer(), tkt.toBuffer()], pid)[0];

  const confirm = async (sig: string) => {
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
    return sig;
  };
  const getData = async (pk: PublicKey) => { const i = await conn.getAccountInfo(pk); return i ? i.data : null; };

  console.log("PHASE:", phase, " admin:", admin.toBase58());
  const mDraw = monthlyDrawPda(1); // primeiro mensal

  // ---------- computa split esperado a partir do monthly_pool ao vivo ----------
  const computeExpected = (snapshot: bigint) => {
    const jackpot = (snapshot * 75n) / 100n;
    const cascade = snapshot - jackpot;
    const tiers = BPS.map((b) => (cascade * b) / BPS_SUM);
    const allocated = tiers.reduce((s, v) => s + v, 0n);
    const closeDust = cascade - allocated;
    // cenário a: só tier 3 (index 2) tem 1 vencedor; tiers 1,2 vazios cascateiam; 4..9 vazios -> leftover
    const carry12 = tiers[0] + tiers[1];
    const tier3Total = tiers[2] + carry12;
    const leftover49 = tiers[3] + tiers[4] + tiers[5] + tiers[6] + tiers[7] + tiers[8];
    const jackpotRollover = jackpot; // sem vencedor
    const totalRollover = jackpotRollover + leftover49 + closeDust;
    const paid = tier3Total; // 1 vencedor, individual = total
    return { snapshot, jackpot, cascade, tiers, allocated, closeDust, tier3Total, leftover49, totalRollover, paid };
  };

  // =========================================================
  if (phase === "setup") {
    const poolBefore = decGlobalMonthlyPool((await getData(globalState))!);
    console.log("monthly_pool ANTES do setup:", poolBefore.toString());

    for (const draw of [DRAW_A, DRAW_B]) {
      const existing = await getData(drawPda(draw));
      if (!existing) {
        const s = await M.openDraw(u64(60)).accounts({ admin, globalState, drawState: drawPda(draw), systemProgram: SystemProgram.programId }).rpc();
        console.log(`open_draw(${draw}):`, await confirm(s));
      } else console.log(`draw ${draw} já existe, pulando open`);

      for (const t of TICKETS.filter((x) => x.draw === draw)) {
        const tkPk = ticketPda(t.draw, t.idx);
        if (await getData(tkPk)) { console.log(`  ${t.label} já existe`); continue; }
        const s = await M.buyTicket(Buffer.from(t.numbers), t.crypto).accounts({
          user: admin, globalState, drawState: drawPda(draw),
          userDrawState: userDrawPda(draw), userGlobalState: userGlobalPda(),
          ticket: tkPk, userTokenAccount: adminAta, prizeVault,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).rpc();
        console.log(`  buy ${t.label} [${t.numbers}] crypto=${t.crypto}:`, await confirm(s));
      }

      const dd = decDraw((await getData(drawPda(draw)))!);
      if (dd.status < 1) {
        const rk = Keypair.generate();
        const s1 = await M.requestRandomness().accounts({ admin, globalState, draw: drawPda(draw), randomnessAccount: rk.publicKey }).rpc();
        console.log(`  request_randomness(${draw}):`, await confirm(s1));
        const s2 = await M.closeDraw().accounts({ admin, globalState, draw: drawPda(draw), randomnessAccountData: rk.publicKey }).rpc();
        console.log(`  close_draw(${draw}):`, await confirm(s2));
      } else console.log(`  draw ${draw} já fechada (status ${dd.status})`);
    }

    console.log("\n--- CONFERÊNCIA FASE 0 ---");
    for (const draw of [DRAW_A, DRAW_B]) {
      const dd = decDraw((await getData(drawPda(draw)))!);
      console.log(`draw ${draw}: status=${dd.status} tickets_sold=${dd.ticketsSold} (esperado status=1, sold=${TICKETS.filter(t=>t.draw===draw).length})`);
    }
    for (const t of TICKETS) console.log(`  ${t.label}: hits=${countHits(t.numbers)} -> tier esperado ${expectedTier(t.numbers, t.crypto)}`);
    const poolAfter = decGlobalMonthlyPool((await getData(globalState))!);
    console.log(`monthly_pool DEPOIS do setup: ${poolAfter}  (delta +${poolAfter - poolBefore}, esperado +800000 = 20% de 4 USDT)`);
    const exp = computeExpected(poolAfter);
    console.log("\n--- PROJEÇÃO FASE 1 (se abrir o mensal AGORA, snapshot =", exp.snapshot.toString(), ") ---");
    console.log("  jackpot_pool:", exp.jackpot.toString(), " cascade_pool:", exp.cascade.toString());
    console.log("  tiers 1..9 alocados:", exp.tiers.map(String).join(", "));
    console.log("  close_time_dust:", exp.closeDust.toString());
    console.log("  [cenário a] tier3 recebe:", exp.tier3Total.toString(), " leftover 4..9:", exp.leftover49.toString());
    console.log("  total_rollover esperado:", exp.totalRollover.toString(), " pago esperado:", exp.paid.toString());
    console.log("  conservação:", (exp.paid + exp.totalRollover).toString(), "== snapshot", exp.snapshot.toString(), exp.paid + exp.totalRollover === exp.snapshot ? "OK" : "!!!");
  }

  // =========================================================
  else if (phase === "open") {
    const gPool = decGlobalMonthlyPool((await getData(globalState))!);
    const pvBefore = tokAmount((await getData(prizeVault))!);
    const mvBefore = tokAmount((await getData(monthlyVault))!);
    const exp = computeExpected(gPool);
    console.log("monthly_pool (=snapshot esperado):", gPool.toString());
    console.log("prize_vault antes:", pvBefore.toString(), " monthly_vault antes:", mvBefore.toString());

    const s = await M.openMonthlyDraw(u64(DRAW_A), u64(DRAW_B)).accounts({
      admin, globalState, monthlyState, monthlyDraw: mDraw, prizeVault, monthlyVault,
      vaultAuthority, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).remainingAccounts([DRAW_A, DRAW_B].map((d) => ({ pubkey: drawPda(d), isWritable: false, isSigner: false }))).rpc();
    console.log("open_monthly_draw:", await confirm(s));

    const md = decMonthlyDraw((await getData(mDraw))!);
    const gPoolAfter = decGlobalMonthlyPool((await getData(globalState))!);
    const pvAfter = tokAmount((await getData(prizeVault))!);
    const mvAfter = tokAmount((await getData(monthlyVault))!);
    const ms = decMonthlyState((await getData(monthlyState))!);

    console.log("\n--- CONFERÊNCIA FASE 1 (a fronteira irreversível) ---");
    const chk = (label: string, real: any, esperado: any) =>
      console.log(`  ${label}: real=${real}  esperado=${esperado}  ${String(real) === String(esperado) ? "OK" : "  <<< DIVERGE"}`);
    chk("monthly_draw.id", md.id, 1n);
    chk("first_draw_id", md.firstDrawId, BigInt(DRAW_A));
    chk("last_draw_id", md.lastDrawId, BigInt(DRAW_B));
    chk("tickets_target", md.ticketsTarget, 4n);
    chk("pool_snapshot", md.poolSnapshot, exp.snapshot);
    chk("jackpot_pool", md.jackpotPool, exp.jackpot);
    chk("cascade_pool", md.cascadePool, exp.cascade);
    chk("jackpot+cascade == snapshot", md.jackpotPool + md.cascadePool, md.poolSnapshot);
    chk("status", md.status, 0);
    chk("global_state.monthly_pool", gPoolAfter, 0n);
    chk("sweep: prize_vault delta", pvBefore - pvAfter, exp.snapshot);
    chk("sweep: monthly_vault delta", mvAfter - mvBefore, exp.snapshot);
    chk("monthly_state.last_covered_draw_id", ms.lastCoveredDrawId, BigInt(DRAW_B));
    chk("monthly_state.current_monthly_id", ms.currentMonthlyId, 1n);
  }

  // =========================================================
  else if (phase === "close") {
    const md0 = decMonthlyDraw((await getData(mDraw))!);
    const exp = computeExpected(md0.poolSnapshot);
    const rk = Keypair.generate();
    const s1 = await M.requestMonthlyRandomness().accounts({ admin, globalState, monthlyDraw: mDraw, randomnessAccount: rk.publicKey }).rpc();
    console.log("request_monthly_randomness:", await confirm(s1));
    const s2 = await M.closeMonthlyDraw().accounts({ admin, globalState, monthlyDraw: mDraw, randomnessAccountData: rk.publicKey }).rpc();
    console.log("close_monthly_draw:", await confirm(s2));

    const md = decMonthlyDraw((await getData(mDraw))!);
    console.log("\n--- CONFERÊNCIA FASE 2 ---");
    const chk = (l: string, r: any, e: any) => console.log(`  ${l}: real=${r}  esperado=${e}  ${String(r) === String(e) ? "OK" : "  <<< DIVERGE"}`);
    chk("result_numbers", JSON.stringify(md.resultNumbers), JSON.stringify(RESULT));
    chk("result_crypto", md.resultCrypto, CRYPTO);
    chk("status", md.status, 1);
    chk("prize_per_tier[0] (jackpot)", md.prizePerTier[0], exp.jackpot);
    for (let i = 0; i < 9; i++) chk(`prize_per_tier[${i + 1}]`, md.prizePerTier[i + 1], exp.tiers[i]);
  }

  // =========================================================
  else if (phase === "settle") {
    const tickets = TICKETS.map((t) => ({ ...t, pk: ticketPda(t.draw, t.idx) }));
    const remaining: any[] = [];
    for (const t of tickets) {
      remaining.push({ pubkey: t.pk, isWritable: false, isSigner: false });
      remaining.push({ pubkey: claimPda(mDraw, t.pk), isWritable: true, isSigner: false });
    }
    const s = await M.settleMonthlyTickets(4).accounts({
      admin, globalState, monthlyDraw: mDraw, systemProgram: SystemProgram.programId,
    }).remainingAccounts(remaining).rpc();
    console.log("settle_monthly_tickets:", await confirm(s));

    const md = decMonthlyDraw((await getData(mDraw))!);
    console.log("\n--- CONFERÊNCIA FASE 3 ---");
    const chk = (l: string, r: any, e: any) => console.log(`  ${l}: real=${r}  esperado=${e}  ${String(r) === String(e) ? "OK" : "  <<< DIVERGE"}`);
    chk("tickets_processed", md.ticketsProcessed, 4n);
    chk("status", md.status, 2);
    chk("winner_counts", JSON.stringify(md.winnerCounts.map(String)), JSON.stringify(["0","0","0","1","0","0","0","0","0","0"]));
    for (const t of tickets) {
      const cd = await getData(claimPda(mDraw, t.pk));
      const tier = cd ? cd[8 + 96] : "AUSENTE";
      console.log(`  claim ${t.label}: tier=${tier}  esperado=${expectedTier(t.numbers, t.crypto)}`);
    }
  }

  // =========================================================
  else if (phase === "finalize") {
    const md0 = decMonthlyDraw((await getData(mDraw))!);
    const exp = computeExpected(md0.poolSnapshot);
    const pvBefore = tokAmount((await getData(prizeVault))!);
    const mvBefore = tokAmount((await getData(monthlyVault))!);
    const gPoolBefore = decGlobalMonthlyPool((await getData(globalState))!);

    const s = await M.finalizeMonthlyPayouts().accounts({
      admin, globalState, monthlyState, monthlyDraw: mDraw, prizeVault, monthlyVault, vaultAuthority, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    console.log("finalize_monthly_payouts:", await confirm(s));

    const md = decMonthlyDraw((await getData(mDraw))!);
    const pvAfter = tokAmount((await getData(prizeVault))!);
    const mvAfter = tokAmount((await getData(monthlyVault))!);
    const gPoolAfter = decGlobalMonthlyPool((await getData(globalState))!);
    console.log("\n--- CONFERÊNCIA FASE 4 ---");
    const chk = (l: string, r: any, e: any) => console.log(`  ${l}: real=${r}  esperado=${e}  ${String(r) === String(e) ? "OK" : "  <<< DIVERGE"}`);
    chk("jackpot_hit", md.jackpotHit, false);
    chk("jackpot_winner_count", md.jackpotWinnerCount, 0n);
    chk("prize_per_tier[0]", md.prizePerTier[0], 0n);
    chk("prize_per_tier[3] (tier3 c/ cascata)", md.prizePerTier[3], exp.tier3Total);
    chk("tier3 >= MIN_PRIZE", md.prizePerTier[3] >= MIN_PRIZE, true);
    for (const i of [1, 2, 4, 5, 6, 7, 8, 9]) chk(`prize_per_tier[${i}]`, md.prizePerTier[i], 0n);
    chk("rollover_to_next_month", md.rolloverToNextMonth, exp.totalRollover);
    chk("status", md.status, 3);
    chk("CONSERVAÇÃO paid+rollover", exp.tier3Total + md.rolloverToNextMonth, md0.poolSnapshot);
    chk("sweep-espelho: monthly_vault delta", mvBefore - mvAfter, exp.totalRollover);
    chk("sweep-espelho: prize_vault delta", pvAfter - pvBefore, exp.totalRollover);
    chk("global_state.monthly_pool delta", gPoolAfter - gPoolBefore, exp.totalRollover);
  }

  // =========================================================
  else if (phase === "pay") {
    const md0 = decMonthlyDraw((await getData(mDraw))!);
    const exp = computeExpected(md0.poolSnapshot);
    const ataBefore = tokAmount((await getData(adminAta))!);
    const mvBefore = tokAmount((await getData(monthlyVault))!);
    const tickets = TICKETS.map((t) => ({ ...t, pk: ticketPda(t.draw, t.idx) }));
    const remaining: any[] = [];
    for (const t of tickets) {
      remaining.push({ pubkey: claimPda(mDraw, t.pk), isWritable: true, isSigner: false });
      remaining.push({ pubkey: adminAta, isWritable: true, isSigner: false });
    }
    const s = await M.payMonthlyWinnersBatch(4).accounts({
      admin, globalState, monthlyState, monthlyDraw: mDraw, monthlyVault, vaultAuthority, tokenProgram: TOKEN_PROGRAM_ID,
    }).remainingAccounts(remaining).rpc();
    console.log("pay_monthly_winners_batch:", await confirm(s));

    const md = decMonthlyDraw((await getData(mDraw))!);
    const ataAfter = tokAmount((await getData(adminAta))!);
    const mvAfter = tokAmount((await getData(monthlyVault))!);
    console.log("\n--- CONFERÊNCIA FASE 5 ---");
    const chk = (l: string, r: any, e: any) => console.log(`  ${l}: real=${r}  esperado=${e}  ${String(r) === String(e) ? "OK" : "  <<< DIVERGE"}`);
    chk("admin ATA delta", ataAfter - ataBefore, exp.tier3Total);
    chk("monthly_vault delta", mvBefore - mvAfter, exp.tier3Total);
    chk("monthly_vault final", mvAfter, 0n);
    chk("tickets_paid", md.ticketsPaid, 1n);
    chk("status", md.status, 4);
    for (const t of tickets) {
      const cd = await getData(claimPda(mDraw, t.pk));
      const paid = cd ? cd[8 + 97] : "?";
      console.log(`  claim ${t.label}: paid=${paid}  (T0 esperado 1, resto 0)`);
    }
  }

  // =========================================================
  else if (phase === "check") {
    const md = decMonthlyDraw((await getData(mDraw))!);
    const ms = decMonthlyState((await getData(monthlyState))!);
    const gPool = decGlobalMonthlyPool((await getData(globalState))!);
    const exp = computeExpected(md.poolSnapshot);
    console.log("--- RECONCILIAÇÃO FINAL ---");
    console.log("monthly_draw:", JSON.stringify({
      id: md.id.toString(), status: md.status, snapshot: md.poolSnapshot.toString(),
      jackpot_hit: md.jackpotHit, rollover: md.rolloverToNextMonth.toString(),
      prize_per_tier: md.prizePerTier.map(String), winner_counts: md.winnerCounts.map(String),
      tickets_target: md.ticketsTarget.toString(), tickets_processed: md.ticketsProcessed.toString(), tickets_paid: md.ticketsPaid.toString(),
    }, null, 2));
    console.log("monthly_state:", JSON.stringify({
      current_monthly_id: ms.currentMonthlyId.toString(), last_covered_draw_id: ms.lastCoveredDrawId.toString(),
      jackpot_carry: ms.jackpotCarry.toString(),
    }, null, 2));
    console.log("global_state.monthly_pool:", gPool.toString());
    console.log("CONSERVAÇÃO:", (exp.tier3Total + md.rolloverToNextMonth).toString(), "== snapshot", md.poolSnapshot.toString(),
      exp.tier3Total + md.rolloverToNextMonth === md.poolSnapshot ? "OK" : "!!!");
    console.log("monthly_vault:", tokAmount((await getData(monthlyVault))!).toString(), "(esperado 0)");
  }

  else console.log("defina PHASE=setup|open|close|settle|finalize|pay|check");
})().catch((e) => {
  console.error("ERRO:", e.message || e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
