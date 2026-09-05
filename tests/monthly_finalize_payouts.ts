import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import {
  SystemProgram,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

/**
 * Sub-etapas 3D (finalize_monthly_payouts) e 3E (pay_monthly_winners_batch):
 * testes de integração com dinheiro rodando de verdade.
 *
 *  MONTHLY DRAW A — jackpot COM ganhador + cascata com gap + anti-dust:
 *   Jackpot: 2 tickets com 6 acertos E crypto=9. Cascata: tier 3 (1 vencedor,
 *   acima do mínimo) e tier 9 (50 vencedores → anti-dust). finalize + pay em
 *   lote, valores por tier, conservação, sweep-espelho, idempotência, 3→4.
 *
 *  MONTHLY DRAW B — jackpot SEM ganhador:
 *   Ninguém acerta o tier 0; jackpot_pool inteiro rola. tier 5 zerado por
 *   anti-dust. pay processa e fecha o ciclo.
 *
 *  MONTHLY DRAW C — jackpot SEM ganhador + cascata (tier 3) COM ganhador e
 *   prêmio ACIMA de $1 (sem anti-dust). Prova ISOLADA da regra central: um
 *   jackpot sem ganhador NÃO impede a cascata de pagar os tiers de baixo —
 *   o tier 3 recebe de verdade no pay_monthly_winners_batch com
 *   jackpot_hit=false.
 */
describe("monthly_finalize_payouts + pay_monthly_winners_batch — Sub-etapas 3D e 3E", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const CU_LIMIT_IX = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const MIN_PRIZE = 1_000_000n;
  const MONTHLY_CASCADE_TIER_BPS = [1200n, 800n, 600n, 500n, 400n, 300n, 300n, 250n, 150n];
  const MONTHLY_CASCADE_BPS_SUM = 4500n;

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")], program.programId
  );
  const [prizeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("prize-vault-v3")], program.programId
  );
  const [treasuryVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury-vault-v3")], program.programId
  );
  const [legalVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("legal-vault-v3")], program.programId
  );
  const [marketingVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("marketing-vault-v3")], program.programId
  );
  const [liquidityVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity-vault-v3")], program.programId
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority-v3")], program.programId
  );
  const [monthlyState] = PublicKey.findProgramAddressSync(
    [Buffer.from("monthly-state-v3")], program.programId
  );
  const [monthlyVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("monthly-vault-v3")], program.programId
  );

  function getDrawPDA(drawId: number | anchor.BN): PublicKey {
    const bn = new anchor.BN(drawId);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("draw-v3"), bn.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  }

  function getMonthlyDrawPDA(id: number | anchor.BN): PublicKey {
    const bn = new anchor.BN(id);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("monthly-draw-v3"), bn.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  }

  function getMonthlyClaimPDA(monthlyDraw: PublicKey, ticket: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("m-claim"), monthlyDraw.toBuffer(), ticket.toBuffer()],
      program.programId
    )[0];
  }

  function getTicketPDA(draw: PublicKey, owner: PublicKey, index: number): PublicKey {
    const idxBuf = Buffer.alloc(4);
    idxBuf.writeUInt32LE(index, 0);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), draw.toBuffer(), owner.toBuffer(), idxBuf],
      program.programId
    )[0];
  }

  function getUserDrawStatePDA(draw: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user-draw"), draw.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];
  }

  function getUserGlobalStatePDA(owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user-global-v3"), owner.toBuffer()],
      program.programId
    )[0];
  }

  // ---- Espelhos em TS da matemática de payouts.rs (mesma tecnica de
  // randomness.rs/scoring.rs: reimplementar pra comparar, nao confiar
  // cegamente no resultado on-chain) ----

  function cascadeAndDivide(
    values: bigint[],
    winnerCounts: bigint[]
  ): { values: bigint[]; leftover: bigint } {
    const n = values.length;
    const v = values.slice();
    let carry = 0n;

    for (let i = 0; i < n; i++) {
      v[i] += carry;
      carry = 0n;
      if (winnerCounts[i] === 0n) {
        carry = v[i];
        v[i] = 0n;
      }
    }

    let leftover = carry;

    for (let i = 0; i < n; i++) {
      if (winnerCounts[i] > 0n && v[i] > 0n) {
        const individual = v[i] / winnerCounts[i];
        if (individual < MIN_PRIZE) {
          leftover += v[i];
          v[i] = 0n;
        } else {
          const totalPaid = individual * winnerCounts[i];
          const residual = v[i] - totalPaid;
          if (residual > 0n) leftover += residual;
          v[i] = individual;
        }
      } else {
        v[i] = 0n;
      }
    }

    return { values: v, leftover };
  }

  function splitEvenly(pool: bigint, winners: bigint): { individual: bigint; residual: bigint } {
    const individual = pool / winners;
    const residual = pool - individual * winners;
    return { individual, residual };
  }

  function countHits(ticketNumbers: number[], resultNums: number[]): number {
    return ticketNumbers.filter((n) => resultNums.includes(n)).length;
  }

  function expectedTier(hits: number, cryptoHit: boolean, numCount: number): number {
    if (hits > numCount) return 255;
    const deficit = numCount - hits;
    if (deficit > 4) return 255;
    const base = deficit * 2;
    return cryptoHit ? base : base + 1;
  }

  function numbersWithHits(result: number[], hits: number, count: number): number[] {
    const picks = result.slice(0, hits);
    const used = new Set(picks);
    let candidate = 1;
    while (picks.length < count) {
      if (!result.includes(candidate) && !used.has(candidate)) {
        picks.push(candidate);
        used.add(candidate);
      }
      candidate++;
      if (candidate > 200) throw new Error("numbersWithHits: não foi possível completar o conjunto");
    }
    return picks;
  }

  // Retry com backoff pra erros transientes do validador local ("Blockhash
  // not found" etc) — o validador fica mais lento conforme a suíte avança e
  // um blockhash pode expirar entre buscar e enviar. Mesma lição do
  // set_crypto_count.ts.
  async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        const msg = e?.message || String(e);
        // Só erros em que a tx comprovadamente NÃO entrou (senão um retry de
        // buyTicket bateria em "account already exists" e falharia de vez).
        const transient = /Blockhash not found|failed to get recent blockhash|429|Too Many Requests|Node is behind|Connection rate limits exceeded/i.test(msg);
        if (!transient || i === attempts) throw e;
        console.log(`      [retry] ${label} tentativa ${i}/${attempts}: ${msg.split("\n")[0]}`);
        await new Promise((r) => setTimeout(r, 400 * i));
      }
    }
    throw lastErr;
  }

  async function fundWallet(
    mintPk: PublicKey,
    tokenAmount: number
  ): Promise<{ kp: Keypair; ata: PublicKey }> {
    const kp = Keypair.generate();
    await withRetry(async () => {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }, "airdrop");
    const ata = await withRetry(() => createAccount(connection, admin, mintPk, kp.publicKey), "createAccount");
    await withRetry(() => mintTo(connection, admin, mintPk, ata, admin, tokenAmount), "mintTo");
    return { kp, ata };
  }

  type DrawRef = { id: anchor.BN; pda: PublicKey };
  type TicketRef = { pda: PublicKey; owner: PublicKey; numbers: number[]; ata: PublicKey };

  // MonthlyClaim não está no IDL (nunca é Account<'info, MonthlyClaim> numa
  // struct de Accounts — settle_monthly_tickets a cria à mão). Decodificamos
  // os bytes manualmente, igual ao monthly_settle_tickets.ts.
  type MonthlyClaimData = {
    monthlyDraw: PublicKey;
    ticket: PublicKey;
    owner: PublicKey;
    tier: number;
    paid: boolean;
    bump: number;
  };

  async function fetchMonthlyClaim(pda: PublicKey): Promise<MonthlyClaimData> {
    const info = await connection.getAccountInfo(pda);
    if (!info) throw new Error(`MonthlyClaim não encontrada: ${pda.toBase58()}`);
    const data = info.data;
    let offset = 8;
    const monthlyDraw = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const ticket = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const owner = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const tier = data.readUInt8(offset); offset += 1;
    const paid = data.readUInt8(offset) !== 0; offset += 1;
    const bump = data.readUInt8(offset);
    return { monthlyDraw, ticket, owner, tier, paid, bump };
  }

  // Paga vencedores do mensal em lotes de PARES [claim, ata]. ~10 pares/tx
  // por causa do limite de 1232 bytes da transação legada (mesma regra do
  // settle_monthly_tickets).
  async function payMonthlyAll(
    monthlyDrawPda: PublicKey,
    tickets: TicketRef[]
  ): Promise<void> {
    const PAY_BATCH = 10;
    for (let offset = 0; offset < tickets.length; offset += PAY_BATCH) {
      const chunk = tickets.slice(offset, offset + PAY_BATCH);
      const remainingAccounts = chunk.flatMap((t) => {
        const claimPda = getMonthlyClaimPDA(monthlyDrawPda, t.pda);
        return [
          { pubkey: claimPda, isWritable: true, isSigner: false },
          { pubkey: t.ata, isWritable: true, isSigner: false },
        ];
      });
      await (program.methods
        .payMonthlyWinnersBatch(chunk.length)
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyState,
          monthlyDraw: monthlyDrawPda,
          monthlyVault,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).remainingAccounts(remainingAccounts)
          .preInstructions([CU_LIMIT_IX])
          .rpc();
    }
  }

  async function openDrawOnly(): Promise<DrawRef> {
    const gs: any = await program.account.globalState.fetch(globalState);
    const nextId = new anchor.BN(gs.currentDrawId || 0).add(new anchor.BN(1));
    const pda = getDrawPDA(nextId);

    await withRetry(() => (program.methods
      .openDraw(new anchor.BN(3600))
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        drawState: pda,
        systemProgram: SystemProgram.programId,
      }).rpc(), "openDraw");

    return { id: nextId, pda };
  }

  async function buyMultipleTickets(
    drawPda: PublicKey,
    numbers: number[],
    crypto: number,
    count: number
  ): Promise<TicketRef[]> {
    const { kp, ata } = await fundWallet(mint, ticketPrice.toNumber() * (count + 1));
    const userDrawState = getUserDrawStatePDA(drawPda, kp.publicKey);
    const userGlobalStateAcc = getUserGlobalStatePDA(kp.publicKey);

    const tickets: TicketRef[] = [];
    for (let i = 0; i < count; i++) {
      const ticketPda = getTicketPDA(drawPda, kp.publicKey, i);
      await withRetry(() => (program.methods
        .buyTicket(Buffer.from(numbers), crypto)
        .accounts as any)({
          user: kp.publicKey,
          globalState,
          drawState: drawPda,
          userDrawState,
          userGlobalState: userGlobalStateAcc,
          ticket: ticketPda,
          userTokenAccount: ata,
          prizeVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([kp]).rpc(), `buyTicket#${i}`);
      tickets.push({ pda: ticketPda, owner: kp.publicKey, numbers, ata });
    }
    return tickets;
  }

  async function closeDrawFor(draw: DrawRef): Promise<[number[], number]> {
    const randomnessKp = Keypair.generate();

    await withRetry(() => (program.methods
      .requestRandomness()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: draw.pda,
        randomnessAccount: randomnessKp.publicKey,
      }).rpc(), "requestRandomness");

    await withRetry(() => (program.methods
      .closeDraw()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: draw.pda,
        randomnessAccountData: randomnessKp.publicKey,
      }).preInstructions([CU_LIMIT_IX]).rpc(), "closeDraw");

    const drawAccount: any = await program.account.draw.fetch(draw.pda);
    return [
      Array.from(drawAccount.resultNumbers as Iterable<number>, (n) => Number(n)),
      Number(drawAccount.resultCrypto),
    ];
  }

  function openMonthlyDrawIx(firstId: anchor.BN, lastId: anchor.BN, monthlyDrawPda: PublicKey, draws: PublicKey[]) {
    return (program.methods
      .openMonthlyDraw(firstId, lastId)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyState,
        monthlyDraw: monthlyDrawPda,
        prizeVault,
        monthlyVault,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).remainingAccounts(draws.map((pk) => ({ pubkey: pk, isWritable: false, isSigner: false })));
  }

  async function closeMonthlyDrawFor(monthlyDrawPda: PublicKey): Promise<void> {
    const randomnessKp = Keypair.generate();

    await (program.methods
      .requestMonthlyRandomness()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyDraw: monthlyDrawPda,
        randomnessAccount: randomnessKp.publicKey,
      }).rpc();

    await (program.methods
      .closeMonthlyDraw()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyDraw: monthlyDrawPda,
        randomnessAccountData: randomnessKp.publicKey,
      }).preInstructions([CU_LIMIT_IX]).rpc();
  }

  async function settleAll(monthlyDrawPda: PublicKey, tickets: PublicKey[]): Promise<void> {
    // ATENCAO: cada ticket vira 2 contas em remaining_accounts (par
    // [ticket, claim]). ~10-13 tickets/lote e' o teto pratico do tamanho
    // de uma transacao legada da Solana (1232 bytes). Os scripts de
    // operacao do mensal (settle 3E + producao) tem que respeitar isso.
    const SETTLE_BATCH = 10;
    for (let offset = 0; offset < tickets.length; offset += SETTLE_BATCH) {
      const chunk = tickets.slice(offset, offset + SETTLE_BATCH);
      // remaining_accounts em PARES [ticket (readonly), claim (writable)] —
      // a claim ainda nao existe, settle_monthly_tickets cria ela via CPI.
      const remainingAccounts = chunk.flatMap((pk) => {
        const claimPda = getMonthlyClaimPDA(monthlyDrawPda, pk);
        return [
          { pubkey: pk, isWritable: false, isSigner: false },
          { pubkey: claimPda, isWritable: true, isSigner: false },
        ];
      });
      await (program.methods
        .settleMonthlyTickets(chunk.length)
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyDraw: monthlyDrawPda,
          systemProgram: SystemProgram.programId,
        }).remainingAccounts(remainingAccounts)
          .preInstructions([CU_LIMIT_IX])
          .rpc();
    }
  }

  let mint: PublicKey;
  let ticketPrice: anchor.BN;
  let numbersCount: number;

  before(async () => {
    const sig = await connection.requestAirdrop(admin.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    let globalAccount: any = null;
    try {
      globalAccount = await program.account.globalState.fetch(globalState);
    } catch (_e) {
      globalAccount = null;
    }

    if (!globalAccount) {
      const usdtMint = await createMint(connection, admin, admin.publicKey, null, 6);
      const bytiMint = await createMint(connection, admin, admin.publicKey, null, 6);
      ticketPrice = new anchor.BN(1_000_000);

      await (program.methods
        .initialize(admin.publicKey, ticketPrice, usdtMint, bytiMint)
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          systemProgram: SystemProgram.programId,
        }).rpc();

      await (program.methods
        .initializeVaults()
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          tokenMint: usdtMint,
          prizeVault,
          treasuryVault,
          legalVault,
          marketingVault,
          liquidityVault,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).rpc();

      mint = usdtMint;
      globalAccount = await program.account.globalState.fetch(globalState);
    } else {
      mint = globalAccount.tokenMint;
      ticketPrice = globalAccount.ticketPrice;
    }

    numbersCount = Number(globalAccount.numbersCount);
    expect(Number(globalAccount.cryptoCount)).to.be.gte(9, "precisa de crypto_count >= 9 pra comprar crypto=9 (jackpot)");

    let monthlyStateAccount: any = null;
    try {
      monthlyStateAccount = await program.account.monthlyState.fetch(monthlyState);
    } catch (_e) {
      monthlyStateAccount = null;
    }
    if (!monthlyStateAccount) {
      await (program.methods
        .initMonthlyState()
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyState,
          systemProgram: SystemProgram.programId,
        }).rpc();
    }

    const monthlyVaultInfo = await connection.getAccountInfo(monthlyVault);
    if (!monthlyVaultInfo) {
      await (program.methods
        .initMonthlyVault()
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyState,
          tokenMint: mint,
          monthlyVault,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).rpc();
    }

    console.log(`    [setup] mint=${mint.toBase58()} ticketPrice=${ticketPrice.toString()} numbersCount=${numbersCount}`);
  });

  let resultNumbers: number[];
  let dDisc: DrawRef;
  let discoveryTicket: TicketRef;

  it("descobre o resultado determinístico do seed de teste (entra no range mensal, não fica solta)", async () => {
    dDisc = await openDrawOnly();
    [discoveryTicket] = await buyMultipleTickets(
      dDisc.pda,
      Array.from({ length: numbersCount }, (_, i) => i + 1),
      1,
      1
    );
    const [numbers, crypto] = await closeDrawFor(dDisc);
    resultNumbers = numbers;
    expect(crypto).to.equal(9, "premissa do teste: seed de teste sempre sorteia crypto=9");
    console.log(`    [discovery] resultNumbers=${resultNumbers} resultCrypto=${crypto}`);
  });

  // =====================================================================
  //  MONTHLY DRAW A — jackpot COM ganhador + cascata com gap + anti-dust
  // =====================================================================

  let dA: DrawRef;
  let jackpotTickets: TicketRef[];
  let tier3Tickets: TicketRef[];
  let tier9Tickets: TicketRef[];
  let allTicketsA: TicketRef[];
  let monthlyDrawAPda: PublicKey;
  let poolSnapshotA: bigint;
  let jackpotPoolA: bigint;
  let cascadePoolA: bigint;

  it("monta a draw A: jackpot (crypto=9, 6 acertos) x2, tier3 x1, tier9 x50 — abre e fecha o mensal", async () => {
    dA = await openDrawOnly();

    const jackpotNumbers = numbersWithHits(resultNumbers, numbersCount, numbersCount);
    jackpotTickets = await buyMultipleTickets(dA.pda, jackpotNumbers, 9, 2);

    const tier3Numbers = numbersWithHits(resultNumbers, numbersCount - 1, numbersCount);
    tier3Tickets = await buyMultipleTickets(dA.pda, tier3Numbers, 1, 1);

    const tier9Numbers = numbersWithHits(resultNumbers, numbersCount - 4, numbersCount);
    tier9Tickets = await buyMultipleTickets(dA.pda, tier9Numbers, 1, 50);

    await closeDrawFor(dA);

    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const lastCovered = Number(msBefore.lastCoveredDrawId);
    const firstDrawId = lastCovered > 0 ? new anchor.BN(lastCovered + 1) : dDisc.id;
    expect(firstDrawId.toNumber()).to.equal(dDisc.id.toNumber(), "pré-condição: dDisc precisa ser contíguo com o último mês fechado");

    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    monthlyDrawAPda = getMonthlyDrawPDA(nextMonthlyId);

    await openMonthlyDrawIx(dDisc.id, dA.id, monthlyDrawAPda, [dDisc.pda, dA.pda]).rpc();

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawAPda);
    poolSnapshotA = BigInt(md.poolSnapshot.toString());
    jackpotPoolA = BigInt(md.jackpotPool.toString());
    cascadePoolA = BigInt(md.cascadePool.toString());
    expect(jackpotPoolA + cascadePoolA).to.equal(poolSnapshotA);
    console.log(`    [draw A] poolSnapshot=${poolSnapshotA} jackpotPool=${jackpotPoolA} cascadePool=${cascadePoolA}`);

    await closeMonthlyDrawFor(monthlyDrawAPda);

    const mdAfter: any = await program.account.monthlyDraw.fetch(monthlyDrawAPda);
    expect(Number(mdAfter.status)).to.equal(1);
  });

  it("settle todos os tickets da draw A (lotes)", async () => {
    allTicketsA = [discoveryTicket, ...jackpotTickets, ...tier3Tickets, ...tier9Tickets];
    expect(allTicketsA.length).to.equal(1 + 2 + 1 + 50);

    await settleAll(monthlyDrawAPda, allTicketsA.map((t) => t.pda));

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawAPda);
    expect(Number(md.ticketsProcessed)).to.equal(allTicketsA.length);
    expect(Number(md.status)).to.equal(2);

    const winnerCounts = md.monthlyWinnerCounts.map((x: any) => Number(x));
    expect(winnerCounts[0]).to.equal(2, "2 vencedores no jackpot");
    expect(winnerCounts[3]).to.equal(1, "1 vencedor no tier 3");
    expect(winnerCounts[9]).to.equal(50, "50 vencedores no tier 9");
    for (const tier of [1, 2, 4, 5, 6, 7, 8]) {
      expect(winnerCounts[tier]).to.equal(0, `tier ${tier} deveria estar vazio (gap)`);
    }
  });

  it("finalize da draw A: jackpot com ganhador, cascata com gap, anti-dust, conservação e sweep-espelho", async () => {
    const monthlyVaultBefore = await getAccount(connection, monthlyVault);
    const prizeVaultBefore = await getAccount(connection, prizeVault);
    const globalBefore: any = await program.account.globalState.fetch(globalState);
    const monthlyPoolBefore = BigInt(globalBefore.monthlyPool.toString());

    // Espelho em TS: recalcula ANTES de chamar a instrução, usando os
    // mesmos dados que o contrato usa.
    const mdBefore: any = await program.account.monthlyDraw.fetch(monthlyDrawAPda);
    const wc = mdBefore.monthlyWinnerCounts.map((x: any) => BigInt(x.toString()));
    const winnerCounts1_9 = [wc[1], wc[2], wc[3], wc[4], wc[5], wc[6], wc[7], wc[8], wc[9]];

    const preCascadeTierValues = MONTHLY_CASCADE_TIER_BPS.map(
      (bps) => (cascadePoolA * bps) / MONTHLY_CASCADE_BPS_SUM
    );
    const closeTimeDust = cascadePoolA - preCascadeTierValues.reduce((a, b) => a + b, 0n);

    const { values: expectedTierValues, leftover: cascadeLeftover } = cascadeAndDivide(
      preCascadeTierValues,
      winnerCounts1_9
    );

    const jackpotWinnerCount = wc[0];
    expect(jackpotWinnerCount).to.equal(2n);
    const { individual: expectedJackpotIndividual, residual: expectedJackpotResidual } = splitEvenly(
      jackpotPoolA,
      jackpotWinnerCount
    );

    const expectedTotalRollover = expectedJackpotResidual + cascadeLeftover + closeTimeDust;

    // 3. Cascata com gap: tier3 (index2) deve ter recebido o carry de
    // tier1+tier2 e ficado ACIMA do mínimo; tier9 (index8) deve ter sido
    // zerado pelo anti-dust (50 vencedores é demais pro pool dele).
    expect(expectedTierValues[2] > 0n).to.equal(true, "tier3 deveria ter sido pago (cascata absorveu tier1+tier2)");
    expect(expectedTierValues[2] >= MIN_PRIZE).to.equal(true, "tier3 nao deveria ter caido no anti-dust");
    expect(expectedTierValues[8]).to.equal(0n, "tier9 deveria ter sido zerado pelo anti-dust");

    // ---- Chama a instrução real ----
    await (program.methods
      .finalizeMonthlyPayouts()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyState,
        monthlyDraw: monthlyDrawAPda,
        prizeVault,
        monthlyVault,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawAPda);

    // 1. Jackpot com ganhador.
    expect(md.jackpotHit).to.equal(true);
    expect(Number(md.jackpotWinnerCount)).to.equal(2);
    expect(BigInt(md.monthlyPrizePerTier[0].toString())).to.equal(expectedJackpotIndividual);

    // 3. Cascata + anti-dust batendo tier a tier com o espelho em TS.
    for (let i = 0; i < 9; i++) {
      expect(BigInt(md.monthlyPrizePerTier[i + 1].toString())).to.equal(
        expectedTierValues[i],
        `tier ${i + 1}`
      );
    }

    // 5. Status 2 -> 3.
    expect(Number(md.status)).to.equal(3);

    // 4. CONSERVAÇÃO: jackpot pago + cascata paga + rollover == pool_snapshot.
    const jackpotPagoTotal = expectedJackpotIndividual * jackpotWinnerCount;
    const cascataPagaTotal = expectedTierValues.reduce((sum, v, i) => sum + v * winnerCounts1_9[i], 0n);
    const rolloverOnChain = BigInt(md.rolloverToNextMonth.toString());

    expect(rolloverOnChain).to.equal(expectedTotalRollover);
    expect(jackpotPagoTotal + cascataPagaTotal + rolloverOnChain).to.equal(
      poolSnapshotA,
      "conservação quebrada: jackpot_pago + cascata_paga + rollover != pool_snapshot"
    );

    // 5 (parte 2). Sweep-espelho: monthly_vault desce o rollover, prize_vault sobe.
    const monthlyVaultAfter = await getAccount(connection, monthlyVault);
    const prizeVaultAfter = await getAccount(connection, prizeVault);
    expect(monthlyVaultBefore.amount - monthlyVaultAfter.amount).to.equal(rolloverOnChain);
    expect(prizeVaultAfter.amount - prizeVaultBefore.amount).to.equal(rolloverOnChain);

    // global_state.monthly_pool aumenta exatamente o rollover.
    const globalAfter: any = await program.account.globalState.fetch(globalState);
    const monthlyPoolAfter = BigInt(globalAfter.monthlyPool.toString());
    expect(monthlyPoolAfter - monthlyPoolBefore).to.equal(rolloverOnChain);

    console.log(`    [finalize A] jackpotIndividual=${expectedJackpotIndividual} tier3=${expectedTierValues[2]} tier9(dust)=${expectedTierValues[8]} rollover=${rolloverOnChain}`);
  });

  it("chamar finalize de novo (status 3) falha — não é idempotente, operação única", async () => {
    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .finalizeMonthlyPayouts()
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyState,
          monthlyDraw: monthlyDrawAPda,
          prizeVault,
          monthlyVault,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "finalize num monthly_draw já finalizado (status 3) deveria falhar");
    expect(errText).to.match(/DrawNotReady/);
  });

  it("pay A (3E): paga jackpot + cascata em lote, valores por tier certos, tier 255 não recebe, idempotência, status 3→4", async function () {
    this.timeout(180_000);

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawAPda);
    expect(Number(md.status)).to.equal(3, "pré-condição: draw A finalizada (status 3)");

    const prizePerTier = md.monthlyPrizePerTier.map((x: any) => BigInt(x.toString()));
    const jackpotPrize = prizePerTier[0];
    const tier3Prize = prizePerTier[3];
    const tier9Prize = prizePerTier[9];
    expect(jackpotPrize > 0n).to.equal(true, "jackpot individual deveria ser > 0");
    expect(tier3Prize >= MIN_PRIZE).to.equal(true, "tier3 deveria pagar acima do mínimo");
    expect(tier9Prize).to.equal(0n, "tier9 foi zerado pelo anti-dust — paga 0");

    const totalWinners = md.monthlyWinnerCounts
      .map((x: any) => BigInt(x.toString()))
      .reduce((a: bigint, b: bigint) => a + b, 0n);
    expect(totalWinners).to.equal(53n, "2 jackpot + 1 tier3 + 50 tier9");

    // ATAs (jackpot e tier3 = 1 carteira cada; tier9 = 1 carteira; discovery = 1)
    const jackpotAta = jackpotTickets[0].ata;
    const tier3Ata = tier3Tickets[0].ata;
    const tier9Ata = tier9Tickets[0].ata;

    const monthlyVaultBefore = await getAccount(connection, monthlyVault);
    const jackpotAtaBefore = await getAccount(connection, jackpotAta);
    const tier3AtaBefore = await getAccount(connection, tier3Ata);
    const tier9AtaBefore = await getAccount(connection, tier9Ata);

    // discoveryTicket é tier 255 (0 acertos) — vem no lote mas não pode receber.
    const discoveryClaimBefore = await fetchMonthlyClaim(
      getMonthlyClaimPDA(monthlyDrawAPda, discoveryTicket.pda)
    );
    expect(discoveryClaimBefore.tier).to.equal(255, "discoveryTicket deveria ser tier 255");
    expect(discoveryClaimBefore.paid).to.equal(false);

    await payMonthlyAll(monthlyDrawAPda, allTicketsA);

    // Valores por tier recebidos.
    const jackpotAtaAfter = await getAccount(connection, jackpotAta);
    const tier3AtaAfter = await getAccount(connection, tier3Ata);
    const tier9AtaAfter = await getAccount(connection, tier9Ata);
    expect(jackpotAtaAfter.amount - jackpotAtaBefore.amount).to.equal(
      jackpotPrize * 2n,
      "carteira do jackpot tem 2 tickets vencedores"
    );
    expect(tier3AtaAfter.amount - tier3AtaBefore.amount).to.equal(tier3Prize);
    expect(tier9AtaAfter.amount - tier9AtaBefore.amount).to.equal(0n, "tier9 paga 0 (anti-dust)");

    // monthly_vault saiu exatamente a soma paga.
    const totalPaid = jackpotPrize * 2n + tier3Prize + tier9Prize * 50n;
    const monthlyVaultAfter = await getAccount(connection, monthlyVault);
    expect(monthlyVaultBefore.amount - monthlyVaultAfter.amount).to.equal(totalPaid);

    // tier 255 não recebeu e a claim não foi marcada paga.
    const discoveryClaimAfter = await fetchMonthlyClaim(
      getMonthlyClaimPDA(monthlyDrawAPda, discoveryTicket.pda)
    );
    expect(discoveryClaimAfter.paid).to.equal(false, "tier 255 não é pago nem marcado");
    // (o vault ter saído exatamente `totalPaid`, conferido acima, já prova
    // que nenhum prêmio foi pro loser)

    // status 3 -> 4, tickets_paid == total_winners (losers não contam).
    const mdPaid: any = await program.account.monthlyDraw.fetch(monthlyDrawAPda);
    expect(Number(mdPaid.status)).to.equal(4);
    expect(BigInt(mdPaid.ticketsPaid.toString())).to.equal(53n);

    // Idempotência: reenviar o primeiro lote não paga de novo nem quebra.
    const jackpotAtaReBefore = await getAccount(connection, jackpotAta);
    const vaultReBefore = await getAccount(connection, monthlyVault);
    await payMonthlyAll(monthlyDrawAPda, allTicketsA.slice(0, 10));
    const jackpotAtaReAfter = await getAccount(connection, jackpotAta);
    const vaultReAfter = await getAccount(connection, monthlyVault);
    expect(jackpotAtaReAfter.amount - jackpotAtaReBefore.amount).to.equal(0n, "reenvio não paga em dobro");
    expect(vaultReBefore.amount - vaultReAfter.amount).to.equal(0n);

    const mdRe: any = await program.account.monthlyDraw.fetch(monthlyDrawAPda);
    expect(Number(mdRe.status)).to.equal(4);
    expect(BigInt(mdRe.ticketsPaid.toString())).to.equal(53n);

    console.log(`    [pay A] jackpot/ticket=${jackpotPrize} tier3=${tier3Prize} tier9=0 totalPaid=${totalPaid}`);
  });

  // =====================================================================
  //  MONTHLY DRAW B — jackpot SEM ganhador
  // =====================================================================

  let dB: DrawRef;
  let loserTicketB: TicketRef;
  let tier5TicketB: TicketRef;
  let monthlyDrawBPda: PublicKey;
  let poolSnapshotB: bigint;
  let jackpotPoolB: bigint;
  let cascadePoolB: bigint;

  it("monta a draw B: 1 perdedor + 1 vencedor tier5 (SEM ninguém no jackpot) — abre e fecha o mensal", async () => {
    dB = await openDrawOnly();

    const loserNumbers = numbersWithHits(resultNumbers, 0, numbersCount);
    [loserTicketB] = await buyMultipleTickets(dB.pda, loserNumbers, 1, 1);

    const tier5Numbers = numbersWithHits(resultNumbers, numbersCount - 2, numbersCount);
    [tier5TicketB] = await buyMultipleTickets(dB.pda, tier5Numbers, 1, 1);

    await closeDrawFor(dB);

    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msBefore.lastCoveredDrawId)).to.equal(dA.id.toNumber(), "pré-condição: dB deve ser contíguo com o mês A");
    expect(dB.id.toNumber()).to.equal(dA.id.toNumber() + 1);

    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    monthlyDrawBPda = getMonthlyDrawPDA(nextMonthlyId);

    await openMonthlyDrawIx(dB.id, dB.id, monthlyDrawBPda, [dB.pda]).rpc();

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawBPda);
    poolSnapshotB = BigInt(md.poolSnapshot.toString());
    jackpotPoolB = BigInt(md.jackpotPool.toString());
    cascadePoolB = BigInt(md.cascadePool.toString());

    await closeMonthlyDrawFor(monthlyDrawBPda);
  });

  it("settle da draw B e finalize: JACKPOT SEM GANHADOR, rollover, monthly_pool e sweep corretos", async () => {
    await settleAll(monthlyDrawBPda, [loserTicketB.pda, tier5TicketB.pda]);

    const mdSettled: any = await program.account.monthlyDraw.fetch(monthlyDrawBPda);
    expect(Number(mdSettled.status)).to.equal(2);
    const wc = mdSettled.monthlyWinnerCounts.map((x: any) => Number(x));
    expect(wc[0]).to.equal(0, "ninguém deveria ter acertado o jackpot");
    expect(wc[5]).to.equal(1, "1 vencedor no tier 5");

    const monthlyVaultBefore = await getAccount(connection, monthlyVault);
    const prizeVaultBefore = await getAccount(connection, prizeVault);
    const globalBefore: any = await program.account.globalState.fetch(globalState);
    const monthlyPoolBefore = BigInt(globalBefore.monthlyPool.toString());

    // Espelho em TS.
    const winnerCounts1_9 = [0n, 0n, 0n, 0n, 1n, 0n, 0n, 0n, 0n]; // só tier5 (index4)
    const preCascadeTierValues = MONTHLY_CASCADE_TIER_BPS.map(
      (bps) => (cascadePoolB * bps) / MONTHLY_CASCADE_BPS_SUM
    );
    const closeTimeDust = cascadePoolB - preCascadeTierValues.reduce((a, b) => a + b, 0n);
    const { values: expectedTierValues, leftover: cascadeLeftover } = cascadeAndDivide(
      preCascadeTierValues,
      winnerCounts1_9
    );
    // Sem ganhador no jackpot: jackpot_pool INTEIRO rola.
    const expectedTotalRollover = jackpotPoolB + cascadeLeftover + closeTimeDust;

    await (program.methods
      .finalizeMonthlyPayouts()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyState,
        monthlyDraw: monthlyDrawBPda,
        prizeVault,
        monthlyVault,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawBPda);

    // 2. Jackpot SEM ganhador.
    expect(md.jackpotHit).to.equal(false);
    expect(Number(md.jackpotWinnerCount)).to.equal(0);
    expect(BigInt(md.monthlyPrizePerTier[0].toString())).to.equal(0n, "monthly_prize_per_tier[0] deveria ser 0");

    for (let i = 0; i < 9; i++) {
      expect(BigInt(md.monthlyPrizePerTier[i + 1].toString())).to.equal(expectedTierValues[i], `tier ${i + 1}`);
    }

    const rolloverOnChain = BigInt(md.rolloverToNextMonth.toString());
    expect(rolloverOnChain).to.equal(expectedTotalRollover);
    expect(rolloverOnChain).to.equal(jackpotPoolB + cascadeLeftover + closeTimeDust);

    // 4. Conservação também aqui.
    const cascataPagaTotal = expectedTierValues.reduce((sum, v, i) => sum + v * winnerCounts1_9[i], 0n);
    expect(cascataPagaTotal + rolloverOnChain).to.equal(poolSnapshotB, "conservação quebrada na draw B");

    // 2 (parte 2) + 5. Sweep-espelho e global_state.monthly_pool sobem exatamente o rollover.
    const monthlyVaultAfter = await getAccount(connection, monthlyVault);
    const prizeVaultAfter = await getAccount(connection, prizeVault);
    expect(monthlyVaultBefore.amount - monthlyVaultAfter.amount).to.equal(rolloverOnChain);
    expect(prizeVaultAfter.amount - prizeVaultBefore.amount).to.equal(rolloverOnChain);

    const globalAfter: any = await program.account.globalState.fetch(globalState);
    const monthlyPoolAfter = BigInt(globalAfter.monthlyPool.toString());
    expect(monthlyPoolAfter - monthlyPoolBefore).to.equal(rolloverOnChain);

    expect(Number(md.status)).to.equal(3);

    console.log(`    [finalize B] jackpotPool(rolou inteiro)=${jackpotPoolB} tier5=${expectedTierValues[4]} rollover=${rolloverOnChain}`);
  });

  it("pay B (3E): sem ganhador de jackpot — tier5 é processado, loser não recebe, status 3→4", async function () {
    this.timeout(120_000);

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawBPda);
    expect(Number(md.status)).to.equal(3, "pré-condição: draw B finalizada");

    const tier5Prize = BigInt(md.monthlyPrizePerTier[5].toString());
    const totalWinners = md.monthlyWinnerCounts
      .map((x: any) => BigInt(x.toString()))
      .reduce((a: bigint, b: bigint) => a + b, 0n);
    expect(totalWinners).to.equal(1n, "só tier5 tem ganhador (jackpot vazio)");

    const tier5Ata = tier5TicketB.ata;
    const tier5AtaBefore = await getAccount(connection, tier5Ata);
    const vaultBefore = await getAccount(connection, monthlyVault);

    const loserClaimBefore = await fetchMonthlyClaim(
      getMonthlyClaimPDA(monthlyDrawBPda, loserTicketB.pda)
    );
    expect(loserClaimBefore.tier).to.equal(255);
    expect(loserClaimBefore.paid).to.equal(false);

    await payMonthlyAll(monthlyDrawBPda, [loserTicketB, tier5TicketB]);

    const tier5AtaAfter = await getAccount(connection, tier5Ata);
    const vaultAfter = await getAccount(connection, monthlyVault);
    expect(tier5AtaAfter.amount - tier5AtaBefore.amount).to.equal(tier5Prize, "tier5 recebe exatamente monthly_prize_per_tier[5]");
    expect(vaultBefore.amount - vaultAfter.amount).to.equal(tier5Prize);

    const loserClaimAfter = await fetchMonthlyClaim(
      getMonthlyClaimPDA(monthlyDrawBPda, loserTicketB.pda)
    );
    expect(loserClaimAfter.paid).to.equal(false, "loser (tier 255) não é pago");

    const mdPaid: any = await program.account.monthlyDraw.fetch(monthlyDrawBPda);
    expect(Number(mdPaid.status)).to.equal(4);
    expect(BigInt(mdPaid.ticketsPaid.toString())).to.equal(1n);

    console.log(`    [pay B] tier5Prize=${tier5Prize} (0 = zerado por anti-dust no finalize)`);
  });

  // =====================================================================
  //  MONTHLY DRAW C — jackpot SEM ganhador + cascata (tier 3) COM ganhador
  //  e prêmio ACIMA de $1 (sem anti-dust).
  //
  //  Prova isolada da regra central: "jackpot sem ganhador NÃO impede a
  //  cascata de pagar os tiers de baixo". A Draw B não provava isso — lá a
  //  cascata zerou por anti-dust, não pela regra do jackpot. Aqui o tier 3
  //  recebe de verdade, no pay_monthly_winners_batch, com jackpot_hit=false.
  // =====================================================================

  let dC: DrawRef;
  let tier3TicketsC: TicketRef[];
  let fillersC: TicketRef[];
  let allTicketsC: TicketRef[];
  let monthlyDrawCPda: PublicKey;
  let poolSnapshotC: bigint;
  let jackpotPoolC: bigint;
  let cascadePoolC: bigint;

  it("monta a draw C: 60 perdedores (enchem o pool) + 1 vencedor tier3, SEM ninguém no jackpot — abre e fecha o mensal", async function () {
    this.timeout(300_000);

    dC = await openDrawOnly();

    // 60 perdedores só pra inflar o monthly_pool via os 20% que entram no
    // fechamento do sorteio diário — assim o quinhão do tier 3 fica bem
    // acima de MIN_PRIZE ($1) e não cai no anti-esmola.
    const loserNumbers = numbersWithHits(resultNumbers, 0, numbersCount);
    fillersC = await buyMultipleTickets(dC.pda, loserNumbers, 1, 60);

    // 1 vencedor de tier 3: deficit 1 (numbersCount-1 acertos), crypto errada.
    const tier3Numbers = numbersWithHits(resultNumbers, numbersCount - 1, numbersCount);
    tier3TicketsC = await buyMultipleTickets(dC.pda, tier3Numbers, 1, 1);

    await closeDrawFor(dC);

    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msBefore.lastCoveredDrawId)).to.equal(dB.id.toNumber(), "pré-condição: dC contíguo com o mês B");
    expect(dC.id.toNumber()).to.equal(dB.id.toNumber() + 1);

    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    monthlyDrawCPda = getMonthlyDrawPDA(nextMonthlyId);

    await openMonthlyDrawIx(dC.id, dC.id, monthlyDrawCPda, [dC.pda]).rpc();

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawCPda);
    poolSnapshotC = BigInt(md.poolSnapshot.toString());
    jackpotPoolC = BigInt(md.jackpotPool.toString());
    cascadePoolC = BigInt(md.cascadePool.toString());
    expect(jackpotPoolC + cascadePoolC).to.equal(poolSnapshotC);
    console.log(`    [draw C] poolSnapshot=${poolSnapshotC} jackpotPool=${jackpotPoolC} cascadePool=${cascadePoolC}`);

    await closeMonthlyDrawFor(monthlyDrawCPda);
    const mdAfter: any = await program.account.monthlyDraw.fetch(monthlyDrawCPda);
    expect(Number(mdAfter.status)).to.equal(1);
  });

  it("settle todos os tickets da draw C (lotes)", async function () {
    this.timeout(300_000);

    allTicketsC = [...tier3TicketsC, ...fillersC];
    expect(allTicketsC.length).to.equal(61);

    await settleAll(monthlyDrawCPda, allTicketsC.map((t) => t.pda));

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawCPda);
    expect(Number(md.ticketsProcessed)).to.equal(61);
    expect(Number(md.status)).to.equal(2);

    const wc = md.monthlyWinnerCounts.map((x: any) => Number(x));
    expect(wc[0]).to.equal(0, "jackpot vazio");
    expect(wc[3]).to.equal(1, "1 vencedor no tier 3");
    for (const tier of [1, 2, 4, 5, 6, 7, 8, 9]) {
      expect(wc[tier]).to.equal(0, `tier ${tier} vazio`);
    }
  });

  it("finalize da draw C: jackpot_hit=false MAS o tier 3 é alocado acima de $1 (cascata independe do jackpot)", async () => {
    const mdBefore: any = await program.account.monthlyDraw.fetch(monthlyDrawCPda);
    const winnerCounts1_9 = [0n, 0n, 1n, 0n, 0n, 0n, 0n, 0n, 0n]; // só tier3 (index2)

    const preCascadeTierValues = MONTHLY_CASCADE_TIER_BPS.map(
      (bps) => (cascadePoolC * bps) / MONTHLY_CASCADE_BPS_SUM
    );
    const closeTimeDust = cascadePoolC - preCascadeTierValues.reduce((a, b) => a + b, 0n);
    const { values: expectedTierValues, leftover: cascadeLeftover } = cascadeAndDivide(
      preCascadeTierValues,
      winnerCounts1_9
    );

    // O ponto do teste: tier3 (index2) absorve o carry de tier1+tier2 e fica
    // ACIMA do mínimo — nada a ver com o jackpot ter tido ganhador ou não.
    expect(expectedTierValues[2] >= MIN_PRIZE).to.equal(true, "tier3 precisa ficar acima de $1 pra não cair no anti-dust");

    // Sem ganhador no jackpot: jackpot_pool INTEIRO rola.
    const expectedTotalRollover = jackpotPoolC + cascadeLeftover + closeTimeDust;

    await (program.methods
      .finalizeMonthlyPayouts()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyState,
        monthlyDraw: monthlyDrawCPda,
        prizeVault,
        monthlyVault,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawCPda);

    // jackpot SEM ganhador
    expect(md.jackpotHit).to.equal(false, "REGRA: jackpot sem ganhador");
    expect(Number(md.jackpotWinnerCount)).to.equal(0);
    expect(BigInt(md.monthlyPrizePerTier[0].toString())).to.equal(0n);

    // ...e MESMO ASSIM a cascata alocou o tier 3
    for (let i = 0; i < 9; i++) {
      expect(BigInt(md.monthlyPrizePerTier[i + 1].toString())).to.equal(expectedTierValues[i], `tier ${i + 1}`);
    }
    expect(BigInt(md.monthlyPrizePerTier[3].toString()) >= MIN_PRIZE).to.equal(
      true,
      "tier 3 alocado acima de $1 apesar de jackpot_hit=false"
    );

    const rolloverOnChain = BigInt(md.rolloverToNextMonth.toString());
    expect(rolloverOnChain).to.equal(expectedTotalRollover);

    // Conservação
    const cascataPagaTotal = expectedTierValues.reduce((sum, v, i) => sum + v * winnerCounts1_9[i], 0n);
    expect(cascataPagaTotal + rolloverOnChain).to.equal(poolSnapshotC, "conservação quebrada na draw C");

    expect(Number(md.status)).to.equal(3);

    console.log(`    [finalize C] jackpotHit=false jackpotPool(rolou)=${jackpotPoolC} tier3=${expectedTierValues[2]} rollover=${rolloverOnChain}`);
  });

  it("pay C (3E): o ganhador do tier 3 RECEBE seu prêmio via pay_monthly_winners_batch, com jackpot_hit=false", async function () {
    this.timeout(180_000);

    const md: any = await program.account.monthlyDraw.fetch(monthlyDrawCPda);
    expect(Number(md.status)).to.equal(3);
    expect(md.jackpotHit).to.equal(false, "confirmando: nenhum ganhador de jackpot");

    const tier3Prize = BigInt(md.monthlyPrizePerTier[3].toString());
    expect(tier3Prize >= MIN_PRIZE).to.equal(true);

    const totalWinners = md.monthlyWinnerCounts
      .map((x: any) => BigInt(x.toString()))
      .reduce((a: bigint, b: bigint) => a + b, 0n);
    expect(totalWinners).to.equal(1n);

    const winnerAta = tier3TicketsC[0].ata;
    const winnerAtaBefore = await getAccount(connection, winnerAta);
    const vaultBefore = await getAccount(connection, monthlyVault);

    // um perdedor qualquer entra no lote junto — não pode receber nada
    const loserClaimPda = getMonthlyClaimPDA(monthlyDrawCPda, fillersC[0].pda);
    const loserClaimBefore = await fetchMonthlyClaim(loserClaimPda);
    expect(loserClaimBefore.tier).to.equal(255);

    await payMonthlyAll(monthlyDrawCPda, allTicketsC);

    const winnerAtaAfter = await getAccount(connection, winnerAta);
    const vaultAfter = await getAccount(connection, monthlyVault);

    // >>> A PROVA <<<  o ganhador da cascata recebeu, mesmo sem jackpot.
    expect(winnerAtaAfter.amount - winnerAtaBefore.amount).to.equal(
      tier3Prize,
      "ganhador do tier 3 recebe seu prêmio apesar de jackpot_hit=false"
    );
    expect(vaultBefore.amount - vaultAfter.amount).to.equal(tier3Prize, "vault saiu só o prêmio do tier 3");

    const loserClaimAfter = await fetchMonthlyClaim(loserClaimPda);
    expect(loserClaimAfter.paid).to.equal(false, "perdedor no lote não recebe nem é marcado");

    const mdPaid: any = await program.account.monthlyDraw.fetch(monthlyDrawCPda);
    expect(Number(mdPaid.status)).to.equal(4, "ciclo mensal fechado (status 4)");
    expect(BigInt(mdPaid.ticketsPaid.toString())).to.equal(1n);

    // idempotência: reenviar não paga de novo
    const winnerReBefore = await getAccount(connection, winnerAta);
    await payMonthlyAll(monthlyDrawCPda, allTicketsC.slice(0, 10));
    const winnerReAfter = await getAccount(connection, winnerAta);
    expect(winnerReAfter.amount - winnerReBefore.amount).to.equal(0n, "reenvio não paga em dobro");

    console.log(`    [pay C] tier3 winner recebeu ${tier3Prize} com jackpot_hit=false — regra provada`);
  });
});
