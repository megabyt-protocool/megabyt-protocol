import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import { SystemProgram, Keypair, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

/**
 * cancel_monthly_draw — escape hatch de emergência (A-1 da auditoria).
 *
 *  1. Cancelar um mensal em status 0 devolve EXATAMENTE o pool_snapshot
 *     (monthly_vault -> prize_vault + monthly_pool re-creditado), reverte
 *     last_covered_draw_id e current_monthly_id, fecha a conta MonthlyDraw,
 *     conservação exata (reverso do open_monthly_draw). E o range volta a
 *     ser cobrível.
 *  2. Não-admin é rejeitado.
 *  3. Cancelar em status 1 / 2 / 3 / 4 FALHA (MonthlyDrawNotCancelable).
 */
describe("cancel_monthly_draw — escape hatch (A-1)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const CU_LIMIT_IX = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const [globalState] = PublicKey.findProgramAddressSync([Buffer.from("global-state-v3")], program.programId);
  const [prizeVault] = PublicKey.findProgramAddressSync([Buffer.from("prize-vault-v3")], program.programId);
  const [treasuryVault] = PublicKey.findProgramAddressSync([Buffer.from("treasury-vault-v3")], program.programId);
  const [legalVault] = PublicKey.findProgramAddressSync([Buffer.from("legal-vault-v3")], program.programId);
  const [marketingVault] = PublicKey.findProgramAddressSync([Buffer.from("marketing-vault-v3")], program.programId);
  const [liquidityVault] = PublicKey.findProgramAddressSync([Buffer.from("liquidity-vault-v3")], program.programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault-authority-v3")], program.programId);
  const [monthlyState] = PublicKey.findProgramAddressSync([Buffer.from("monthly-state-v3")], program.programId);
  const [monthlyVault] = PublicKey.findProgramAddressSync([Buffer.from("monthly-vault-v3")], program.programId);

  const leU64 = (n: number | anchor.BN) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);
  const getDrawPDA = (id: number | anchor.BN) =>
    PublicKey.findProgramAddressSync([Buffer.from("draw-v3"), leU64(id)], program.programId)[0];
  const getMonthlyDrawPDA = (id: number | anchor.BN) =>
    PublicKey.findProgramAddressSync([Buffer.from("monthly-draw-v3"), leU64(id)], program.programId)[0];
  const getMonthlyClaimPDA = (mDraw: PublicKey, ticket: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("m-claim"), mDraw.toBuffer(), ticket.toBuffer()], program.programId)[0];
  const getTicketPDA = (draw: PublicKey, owner: PublicKey, index: number) => {
    const idxBuf = Buffer.alloc(4);
    idxBuf.writeUInt32LE(index, 0);
    return PublicKey.findProgramAddressSync([Buffer.from("ticket"), draw.toBuffer(), owner.toBuffer(), idxBuf], program.programId)[0];
  };
  const getUserDrawStatePDA = (draw: PublicKey, owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("user-draw"), draw.toBuffer(), owner.toBuffer()], program.programId)[0];
  const getUserGlobalStatePDA = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("user-global-v3"), owner.toBuffer()], program.programId)[0];

  async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        const msg = e?.message || String(e);
        const transient = /Blockhash not found|failed to get recent blockhash|429|Too Many Requests|Node is behind|Connection rate limits exceeded/i.test(msg);
        if (!transient || i === attempts) throw e;
        await new Promise((r) => setTimeout(r, 400 * i));
      }
    }
    throw lastErr;
  }

  async function fundWallet(tokenAmount: number): Promise<{ kp: Keypair; ata: PublicKey }> {
    const kp = Keypair.generate();
    await withRetry(async () => {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }, "airdrop");
    const ata = await withRetry(() => createAccount(connection, admin, mint, kp.publicKey), "createAccount");
    await withRetry(() => mintTo(connection, admin, mint, ata, admin, tokenAmount), "mintTo");
    return { kp, ata };
  }

  type DrawRef = { id: anchor.BN; pda: PublicKey };
  type TicketRef = { pda: PublicKey; owner: PublicKey; ata: PublicKey };

  async function openDrawOnly(): Promise<DrawRef> {
    const gs: any = await program.account.globalState.fetch(globalState);
    const nextId = new anchor.BN(Number(gs.currentDrawId || 0) + 1);
    const pda = getDrawPDA(nextId);
    await withRetry(() => (program.methods.openDraw(new anchor.BN(3600)).accounts as any)({
      admin: admin.publicKey, globalState, drawState: pda, systemProgram: SystemProgram.programId,
    }).rpc(), "openDraw");
    return { id: nextId, pda };
  }

  async function buyLosers(drawPda: PublicKey, count: number): Promise<TicketRef[]> {
    const { kp, ata } = await fundWallet(1_000_000 * (count + 1));
    const nums = [1, 2, 3, 4, 6, 7, 8].slice(0, numbersCount); // nenhum em [5,17,27,32,51,57]
    const out: TicketRef[] = [];
    for (let i = 0; i < count; i++) {
      const ticketPda = getTicketPDA(drawPda, kp.publicKey, i);
      await withRetry(() => (program.methods.buyTicket(Buffer.from(nums), 1).accounts as any)({
        user: kp.publicKey, globalState, drawState: drawPda,
        userDrawState: getUserDrawStatePDA(drawPda, kp.publicKey), userGlobalState: getUserGlobalStatePDA(kp.publicKey),
        ticket: ticketPda, userTokenAccount: ata, prizeVault,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([kp]).rpc(), `buy#${i}`);
      out.push({ pda: ticketPda, owner: kp.publicKey, ata });
    }
    return out;
  }

  async function closeDailyDraw(draw: DrawRef): Promise<void> {
    const rk = Keypair.generate();
    await withRetry(() => (program.methods.requestRandomness().accounts as any)({
      admin: admin.publicKey, globalState, draw: draw.pda, randomnessAccount: rk.publicKey,
    }).rpc(), "requestRandomness");
    await withRetry(() => (program.methods.closeDraw().accounts as any)({
      admin: admin.publicKey, globalState, draw: draw.pda, randomnessAccountData: rk.publicKey,
    }).preInstructions([CU_LIMIT_IX]).rpc(), "closeDraw");
  }

  function openMonthlyIx(firstId: anchor.BN, lastId: anchor.BN, mDrawPda: PublicKey, draws: PublicKey[]) {
    return (program.methods.openMonthlyDraw(firstId, lastId).accounts as any)({
      admin: admin.publicKey, globalState, monthlyState, monthlyDraw: mDrawPda, prizeVault, monthlyVault,
      vaultAuthority, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).remainingAccounts(draws.map((pk) => ({ pubkey: pk, isWritable: false, isSigner: false })));
  }

  function cancelIx(mDrawPda: PublicKey, signer = admin) {
    return (program.methods.cancelMonthlyDraw().accounts as any)({
      admin: signer.publicKey, globalState, monthlyState, monthlyDraw: mDrawPda, prizeVault, monthlyVault,
      vaultAuthority, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers(signer === admin ? [] : [signer]);
  }

  async function closeMonthly(mDrawPda: PublicKey): Promise<void> {
    const rk = Keypair.generate();
    await (program.methods.requestMonthlyRandomness().accounts as any)({
      admin: admin.publicKey, globalState, monthlyDraw: mDrawPda, randomnessAccount: rk.publicKey,
    }).rpc();
    await (program.methods.closeMonthlyDraw().accounts as any)({
      admin: admin.publicKey, globalState, monthlyDraw: mDrawPda, randomnessAccountData: rk.publicKey,
    }).preInstructions([CU_LIMIT_IX]).rpc();
  }

  async function settleMonthly(mDrawPda: PublicKey, tickets: PublicKey[]): Promise<void> {
    const remaining = tickets.flatMap((pk) => [
      { pubkey: pk, isWritable: false, isSigner: false },
      { pubkey: getMonthlyClaimPDA(mDrawPda, pk), isWritable: true, isSigner: false },
    ]);
    await (program.methods.settleMonthlyTickets(tickets.length).accounts as any)({
      admin: admin.publicKey, globalState, monthlyDraw: mDrawPda, systemProgram: SystemProgram.programId,
    }).remainingAccounts(remaining).preInstructions([CU_LIMIT_IX]).rpc();
  }

  let mint: PublicKey;
  let numbersCount: number;

  before(async () => {
    const sig = await connection.requestAirdrop(admin.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    let gs: any = null;
    try { gs = await program.account.globalState.fetch(globalState); } catch (_e) { gs = null; }
    if (!gs) {
      const usdtMint = await createMint(connection, admin, admin.publicKey, null, 6);
      const bytiMint = await createMint(connection, admin, admin.publicKey, null, 6);
      await (program.methods.initialize(admin.publicKey, new anchor.BN(1_000_000), usdtMint, bytiMint).accounts as any)({
        admin: admin.publicKey, globalState, systemProgram: SystemProgram.programId,
      }).rpc();
      await (program.methods.initializeVaults().accounts as any)({
        admin: admin.publicKey, globalState, tokenMint: usdtMint, prizeVault, treasuryVault, legalVault,
        marketingVault, liquidityVault, vaultAuthority, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
      mint = usdtMint;
      gs = await program.account.globalState.fetch(globalState);
    } else {
      mint = gs.tokenMint;
    }
    numbersCount = Number(gs.numbersCount);

    let ms: any = null;
    try { ms = await program.account.monthlyState.fetch(monthlyState); } catch (_e) { ms = null; }
    if (!ms) {
      await (program.methods.initMonthlyState().accounts as any)({
        admin: admin.publicKey, globalState, monthlyState, systemProgram: SystemProgram.programId,
      }).rpc();
    }
    if (!(await connection.getAccountInfo(monthlyVault))) {
      await (program.methods.initMonthlyVault().accounts as any)({
        admin: admin.publicKey, globalState, monthlyState, tokenMint: mint, monthlyVault, vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    }
    console.log(`    [setup] mint=${mint.toBase58()} numbersCount=${numbersCount}`);
  });

  let dailyDrawId: number; // reusado entre o teste 1 (cancelado) e o teste 2 (re-coberto)
  let dailyTickets: TicketRef[]; // as 3 tickets da daily draw (idem)
  let stateBeforeT1: { lastCovered: number; currentId: number };

  it("cancela um mensal em status 0: devolve o pool_snapshot exato, reverte o estado, fecha a conta, conservação", async function () {
    this.timeout(120_000);

    // --- monta 1 daily draw fechada, contígua ---
    const d = await openDrawOnly();
    dailyDrawId = d.id.toNumber();
    dailyTickets = await buyLosers(d.pda, 3);
    await closeDailyDraw(d);

    const msBefore0: any = await program.account.monthlyState.fetch(monthlyState);
    const lastCov0 = Number(msBefore0.lastCoveredDrawId);
    // primeiro mês (last_covered == 0): sem restrição de contiguidade.
    // meses seguintes: tem que começar em last_covered + 1.
    const firstId = lastCov0 > 0 ? lastCov0 + 1 : dailyDrawId;
    expect(firstId).to.equal(dailyDrawId, "pré-condição: daily draw contígua com o último mês");

    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const gsBefore: any = await program.account.globalState.fetch(globalState);
    const monthlyPoolBefore = BigInt(gsBefore.monthlyPool.toString());
    const lastCoveredBefore = Number(msBefore.lastCoveredDrawId);
    const currentIdBefore = Number(msBefore.currentMonthlyId);
    stateBeforeT1 = { lastCovered: lastCoveredBefore, currentId: currentIdBefore };
    const prizeVaultBefore = (await getAccount(connection, prizeVault)).amount;
    const monthlyVaultBefore = (await getAccount(connection, monthlyVault)).amount;

    const nextMonthlyId = currentIdBefore + 1;
    const mDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    // --- open ---
    await openMonthlyIx(new anchor.BN(dailyDrawId), new anchor.BN(dailyDrawId), mDrawPda, [d.pda]).rpc();

    const md: any = await program.account.monthlyDraw.fetch(mDrawPda);
    const S = BigInt(md.poolSnapshot.toString());
    expect(S > 0n).to.equal(true, "pool_snapshot deve ser > 0");
    expect(Number(md.status)).to.equal(0);

    // efeitos do open
    const gsAfterOpen: any = await program.account.globalState.fetch(globalState);
    expect(BigInt(gsAfterOpen.monthlyPool.toString())).to.equal(monthlyPoolBefore - S, "open: monthly_pool -= S");
    expect((await getAccount(connection, monthlyVault)).amount).to.equal(monthlyVaultBefore + S, "open: monthly_vault += S");
    expect((await getAccount(connection, prizeVault)).amount).to.equal(prizeVaultBefore - S, "open: prize_vault -= S");
    const msAfterOpen: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msAfterOpen.lastCoveredDrawId)).to.equal(dailyDrawId);
    expect(Number(msAfterOpen.currentMonthlyId)).to.equal(nextMonthlyId);

    // --- non-admin é rejeitado (na conta em status 0, antes do cancel de verdade) ---
    const intruder = Keypair.generate();
    {
      const airdropSig = await connection.requestAirdrop(intruder.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig, "confirmed");
    }
    let intruderThrew = false;
    let intruderErr = "";
    try {
      await cancelIx(mDrawPda, intruder).rpc();
    } catch (e: any) {
      intruderThrew = true;
      intruderErr = e?.message || String(e);
    }
    expect(intruderThrew).to.equal(true, "não-admin NÃO pode cancelar");
    expect(intruderErr).to.match(/Unauthorized|has[_ ]one|ConstraintHasOne/i);

    // --- cancel (admin) ---
    await cancelIx(mDrawPda).rpc();

    // conta fechada
    expect(await connection.getAccountInfo(mDrawPda)).to.equal(null, "MonthlyDraw fechada");

    // dinheiro: reverso EXATO do open
    expect((await getAccount(connection, monthlyVault)).amount).to.equal(monthlyVaultBefore, "cancel: monthly_vault volta ao inicial");
    expect((await getAccount(connection, prizeVault)).amount).to.equal(prizeVaultBefore, "cancel: prize_vault volta ao inicial");
    const gsFinal: any = await program.account.globalState.fetch(globalState);
    expect(BigInt(gsFinal.monthlyPool.toString())).to.equal(monthlyPoolBefore, "cancel: monthly_pool re-creditado (net open+cancel = 0)");

    // estado revertido
    const msFinal: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msFinal.lastCoveredDrawId)).to.equal(lastCoveredBefore, "last_covered_draw_id revertido");
    expect(Number(msFinal.currentMonthlyId)).to.equal(currentIdBefore, "current_monthly_id revertido");

    // conservação: prize_vault delta (open) == monthly_vault delta (open) == S, e tudo volta
    console.log(`    [cancel] pool_snapshot=${S} devolvido; last_covered ${lastCoveredBefore} / current_id ${currentIdBefore} revertidos`);
  });

  it("rejeita cancelar em status 1, 2, 3 e 4 (MonthlyDrawNotCancelable)", async function () {
    this.timeout(180_000);

    // re-cobre a mesma daily draw do teste 1 (o cancel a devolveu ao pool)
    const ms: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(ms.currentMonthlyId)).to.equal(stateBeforeT1.currentId, "pré-condição: cancel reverteu current_monthly_id");
    expect(Number(ms.lastCoveredDrawId)).to.equal(stateBeforeT1.lastCovered, "pré-condição: cancel reverteu last_covered");
    expect(Number(ms.lastCoveredDrawId)).to.be.lessThan(dailyDrawId, "a daily draw voltou a ser cobrível");

    const nextMonthlyId = Number(ms.currentMonthlyId) + 1;
    const mDrawPda = getMonthlyDrawPDA(nextMonthlyId);
    const dPda = getDrawPDA(dailyDrawId);

    await openMonthlyIx(new anchor.BN(dailyDrawId), new anchor.BN(dailyDrawId), mDrawPda, [dPda]).rpc();

    const tickets = dailyTickets.map((t) => t.pda);
    expect(tickets.length).to.equal(3, "as 3 tickets da daily draw");

    const expectFail = async (label: string) => {
      let threw = false, err = "";
      try { await cancelIx(mDrawPda).rpc(); } catch (e: any) { threw = true; err = e?.message || String(e); }
      expect(threw).to.equal(true, `cancel em ${label} deveria falhar`);
      expect(err).to.match(/MonthlyDrawNotCancelable/, `${label}: erro esperado MonthlyDrawNotCancelable`);
    };

    // status 1
    await closeMonthly(mDrawPda);
    expect(Number((await program.account.monthlyDraw.fetch(mDrawPda)).status)).to.equal(1);
    await expectFail("status 1");

    // status 2
    await settleMonthly(mDrawPda, tickets);
    expect(Number((await program.account.monthlyDraw.fetch(mDrawPda)).status)).to.equal(2);
    await expectFail("status 2");

    // status 3
    await (program.methods.finalizeMonthlyPayouts().accounts as any)({
      admin: admin.publicKey, globalState, monthlyState, monthlyDraw: mDrawPda, prizeVault, monthlyVault,
      vaultAuthority, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    expect(Number((await program.account.monthlyDraw.fetch(mDrawPda)).status)).to.equal(3);
    await expectFail("status 3");

    // status 4 (0 vencedores → fast-path)
    await (program.methods.payMonthlyWinnersBatch(0).accounts as any)({
      admin: admin.publicKey, globalState, monthlyState, monthlyDraw: mDrawPda, monthlyVault,
      vaultAuthority, tokenProgram: TOKEN_PROGRAM_ID,
    }).remainingAccounts([]).rpc();
    expect(Number((await program.account.monthlyDraw.fetch(mDrawPda)).status)).to.equal(4);
    await expectFail("status 4");

    console.log("    [reject] cancel rejeitado corretamente em status 1/2/3/4");
  });
});
