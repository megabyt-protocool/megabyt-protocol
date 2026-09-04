import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  SystemProgram,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

/**
 * Valida a Sub-etapa 3A (open_monthly_draw) — SÓ abertura do sorteio mensal.
 * Nenhuma lógica de settle/finalize/pay mensal existe ainda.
 *
 *  1. Abertura normal: snapshot de monthly_pool, split 75% jackpot / 25%
 *     cascata (soma exata, sem perda de arredondamento), tickets_target
 *     recalculado a partir das Draws do range.
 *  2. Sweep físico: prize_vault cai exatamente `snapshot`, monthly_vault
 *     sobe exatamente `snapshot`.
 *  3. global_state.monthly_pool é debitado em exatamente `snapshot`.
 *  4. Rejeita Draw ainda aberta (status < 1) no range.
 *  5. Rejeita range com duplicata (mesma draw citada duas vezes).
 *  6. Rejeita gap ENTRE dois meses consecutivos (first_draw_id não é
 *     last_covered_draw_id + 1).
 *  7. Uma chamada rejeitada não deixa nenhum efeito colateral (atomicidade
 *     observável — a atomicidade "no meio da instrução" em si é garantida
 *     pelo runtime da Solana, não é algo que dá pra isolar de fora sem
 *     injetar falha artificial no código de produção; o que dá pra provar
 *     de fora é que nada muda quando a chamada falha).
 *
 * Independente dos outros arquivos de teste: reaproveita global_state,
 * vaults, monthly_state e monthly_vault se já existirem na mesma validator.
 */
describe("open_monthly_draw — Sub-etapa 3A (só abertura)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const CU_LIMIT_IX = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

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

  async function fundWallet(
    mintPk: PublicKey,
    tokenAmount: number
  ): Promise<{ kp: Keypair; ata: PublicKey }> {
    const kp = Keypair.generate();
    const sig = await connection.requestAirdrop(kp.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    const ata = await createAccount(connection, admin, mintPk, kp.publicKey);
    await mintTo(connection, admin, mintPk, ata, admin, tokenAmount);
    return { kp, ata };
  }

  type DrawRef = { id: anchor.BN; pda: PublicKey };

  async function openDrawOnly(): Promise<DrawRef> {
    const gs: any = await program.account.globalState.fetch(globalState);
    const nextId = new anchor.BN(gs.currentDrawId || 0).add(new anchor.BN(1));
    const pda = getDrawPDA(nextId);

    await (program.methods
      .openDraw(new anchor.BN(3600))
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        drawState: pda,
        systemProgram: SystemProgram.programId,
      }).rpc();

    return { id: nextId, pda };
  }

  async function buyOneTicket(drawPda: PublicKey): Promise<void> {
    const { kp, ata } = await fundWallet(mint, ticketPrice.toNumber() * 2);
    const ticketPda = getTicketPDA(drawPda, kp.publicKey, 0);
    const userDrawState = getUserDrawStatePDA(drawPda, kp.publicKey);
    const userGlobalStateAcc = getUserGlobalStatePDA(kp.publicKey);
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    await (program.methods
      .buyTicket(Buffer.from(numbers), 1)
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
      }).signers([kp]).rpc();
  }

  async function closeDrawFor(draw: DrawRef): Promise<void> {
    const randomnessKp = Keypair.generate();

    await (program.methods
      .requestRandomness()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: draw.pda,
        randomnessAccount: randomnessKp.publicKey,
      }).rpc();

    await (program.methods
      .closeDraw()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: draw.pda,
        randomnessAccountData: randomnessKp.publicKey,
      }).preInstructions([CU_LIMIT_IX]).rpc();
  }

  async function openBuyCloseDraw(): Promise<DrawRef> {
    const d = await openDrawOnly();
    await buyOneTicket(d.pda);
    await closeDrawFor(d);
    return d;
  }

  function openMonthlyDrawIx(
    firstId: anchor.BN,
    lastId: anchor.BN,
    monthlyDrawPda: PublicKey,
    remainingDraws: PublicKey[]
  ) {
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
      }).remainingAccounts(
        remainingDraws.map((pk) => ({ pubkey: pk, isWritable: false, isSigner: false }))
      );
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

    console.log(`    [setup] mint=${mint.toBase58()} ticketPrice=${ticketPrice.toString()}`);
  });

  let d1: DrawRef, d2: DrawRef, d3: DrawRef;

  it("prepara 3 sorteios diários fechados para servir de range mensal", async () => {
    d1 = await openBuyCloseDraw();
    d2 = await openBuyCloseDraw();
    d3 = await openBuyCloseDraw();

    expect(d2.id.toNumber()).to.equal(d1.id.toNumber() + 1, "draws deveriam ter ids contíguos");
    expect(d3.id.toNumber()).to.equal(d2.id.toNumber() + 1);

    for (const d of [d1, d2, d3]) {
      const drawAccount: any = await program.account.draw.fetch(d.pda);
      expect(Number(drawAccount.status)).to.be.gte(1, "draw deveria estar fechada");
      expect(Number(drawAccount.ticketsSold)).to.equal(1);
    }
  });

  it("abre o sorteio mensal: snapshot, split 75/25, sweep e débito corretos", async () => {
    const gsBefore: any = await program.account.globalState.fetch(globalState);
    const snapshotExpected = BigInt(gsBefore.monthlyPool.toString());
    expect(snapshotExpected > 0n).to.equal(true, "monthly_pool deveria ter acumulado algo dos 3 sorteios diários");

    const prizeVaultBefore = await getAccount(connection, prizeVault);
    const monthlyVaultBefore = await getAccount(connection, monthlyVault);

    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    const monthlyDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    await openMonthlyDrawIx(d1.id, d3.id, monthlyDrawPda, [d1.pda, d2.pda, d3.pda]).rpc();

    const monthlyDraw: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);

    expect(Number(monthlyDraw.id)).to.equal(nextMonthlyId);
    expect(Number(monthlyDraw.firstDrawId)).to.equal(d1.id.toNumber());
    expect(Number(monthlyDraw.lastDrawId)).to.equal(d3.id.toNumber());
    expect(Number(monthlyDraw.ticketsTarget)).to.equal(3);
    expect(Number(monthlyDraw.status)).to.equal(0);

    const poolSnapshot = BigInt(monthlyDraw.poolSnapshot.toString());
    const jackpotPool = BigInt(monthlyDraw.jackpotPool.toString());
    const cascadePool = BigInt(monthlyDraw.cascadePool.toString());

    expect(poolSnapshot).to.equal(snapshotExpected);
    expect(jackpotPool).to.equal((snapshotExpected * 75n) / 100n);
    expect(jackpotPool + cascadePool).to.equal(snapshotExpected, "split 75/25 deve somar exatamente o snapshot, sem perda de arredondamento");

    // Sweep físico: prize_vault caiu exatamente o snapshot, monthly_vault subiu exatamente o snapshot.
    const prizeVaultAfter = await getAccount(connection, prizeVault);
    const monthlyVaultAfter = await getAccount(connection, monthlyVault);
    expect(prizeVaultBefore.amount - prizeVaultAfter.amount).to.equal(snapshotExpected);
    expect(monthlyVaultAfter.amount - monthlyVaultBefore.amount).to.equal(snapshotExpected);

    // Débito: monthly_pool cai exatamente o snapshot (== 0, já que debitamos o valor inteiro).
    const gsAfter: any = await program.account.globalState.fetch(globalState);
    expect(BigInt(gsAfter.monthlyPool.toString())).to.equal(0n);

    const msAfter: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msAfter.currentMonthlyId)).to.equal(nextMonthlyId);
    expect(Number(msAfter.lastCoveredDrawId)).to.equal(d3.id.toNumber());
  });

  let dOpen: DrawRef;

  it("rejeita Draw ainda aberta (status < 1) no range — e não deixa efeito colateral (atomicidade observável)", async () => {
    dOpen = await openDrawOnly();
    await buyOneTicket(dOpen.pda); // precisa de >=1 ticket pra poder ser fechada depois

    const gsBefore: any = await program.account.globalState.fetch(globalState);
    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const prizeVaultBefore = await getAccount(connection, prizeVault);
    const monthlyVaultBefore = await getAccount(connection, monthlyVault);

    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    const monthlyDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    let threw = false;
    let errText = "";
    try {
      await openMonthlyDrawIx(dOpen.id, dOpen.id, monthlyDrawPda, [dOpen.pda]).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "deveria rejeitar draw ainda aberta");
    expect(errText).to.match(/DrawNotReady/);

    // A conta MonthlyDraw não deveria ter sido criada (init falhou/reverteu).
    const info = await connection.getAccountInfo(monthlyDrawPda);
    expect(info).to.equal(null);

    // Nenhum efeito colateral: nem o contador, nem os vaults, nem o
    // MonthlyState mudaram — a transação inteira reverteu (garantia do
    // runtime da Solana: qualquer erro no meio de uma instrução desfaz
    // TUDO que ela tinha feito, inclusive a CPI de transferência e a
    // própria criação da conta MonthlyDraw via `init`).
    const gsAfter: any = await program.account.globalState.fetch(globalState);
    const msAfter: any = await program.account.monthlyState.fetch(monthlyState);
    const prizeVaultAfter = await getAccount(connection, prizeVault);
    const monthlyVaultAfter = await getAccount(connection, monthlyVault);

    expect(gsAfter.monthlyPool.toString()).to.equal(gsBefore.monthlyPool.toString());
    expect(Number(msAfter.currentMonthlyId)).to.equal(Number(msBefore.currentMonthlyId));
    expect(Number(msAfter.lastCoveredDrawId)).to.equal(Number(msBefore.lastCoveredDrawId));
    expect(prizeVaultAfter.amount).to.equal(prizeVaultBefore.amount);
    expect(monthlyVaultAfter.amount).to.equal(monthlyVaultBefore.amount);

    // Fecha dOpen agora (já tem 1 ticket) pra não deixar um draw_id
    // permanentemente "preso" (sem isso, nenhum range futuro conseguiria
    // satisfazer a contiguidade, já que essa draw nunca poderia ser
    // incluída nem fechada de novo).
    await closeDrawFor(dOpen);
  });

  it("fecha o intervalo consumido pelo teste anterior com um mensal válido de 1 draw só", async () => {
    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    const monthlyDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    await openMonthlyDrawIx(dOpen.id, dOpen.id, monthlyDrawPda, [dOpen.pda]).rpc();

    const monthlyDraw: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(monthlyDraw.ticketsTarget)).to.equal(1);

    const msAfter: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msAfter.lastCoveredDrawId)).to.equal(dOpen.id.toNumber());
  });

  let dX: DrawRef, dY: DrawRef;

  it("rejeita range com duplicata (mesma draw citada duas vezes no lugar de duas draws distintas)", async () => {
    dX = await openBuyCloseDraw(); // contíguo: dX.id == dOpen.id + 1
    dY = await openBuyCloseDraw(); // dY.id == dX.id + 1

    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    expect(dX.id.toNumber()).to.equal(Number(msBefore.lastCoveredDrawId) + 1, "pré-condição: dX deve ser contíguo com o último mês fechado");

    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    const monthlyDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    // Range declarado [dX, dY] (2 draws), mas remainingAccounts repete dX
    // duas vezes em vez de [dX, dY] — bate na contagem (2 contas == range
    // de 2), mas dY nunca é citada e dX aparece 2x.
    let threw = false;
    let errText = "";
    try {
      await openMonthlyDrawIx(dX.id, dY.id, monthlyDrawPda, [dX.pda, dX.pda]).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "deveria rejeitar duplicata dentro do range");
    expect(errText).to.match(/InvalidMonthlyRange/);

    const msAfter: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msAfter.lastCoveredDrawId)).to.equal(Number(msBefore.lastCoveredDrawId), "nao deveria ter avancado o cursor");
  });

  it("rejeita gap ENTRE dois meses consecutivos (first_draw_id != last_covered_draw_id + 1)", async () => {
    // dX (criada no teste anterior) nunca foi incluída em nenhum sorteio
    // mensal bem-sucedido. Pular direto pra dY cria um gap real.
    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    const monthlyDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    let threw = false;
    let errText = "";
    try {
      await openMonthlyDrawIx(dY.id, dY.id, monthlyDrawPda, [dY.pda]).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "deveria rejeitar o gap (pulou dX)");
    expect(errText).to.match(/InvalidMonthlyRange/);

    const msAfter: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msAfter.lastCoveredDrawId)).to.equal(Number(msBefore.lastCoveredDrawId));
  });

  it("fecha o gap corretamente com o range [dX, dY] — confirma que o caminho feliz continua funcionando", async () => {
    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    const monthlyDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    await openMonthlyDrawIx(dX.id, dY.id, monthlyDrawPda, [dX.pda, dY.pda]).rpc();

    const monthlyDraw: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(monthlyDraw.ticketsTarget)).to.equal(2);

    const msAfter: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msAfter.lastCoveredDrawId)).to.equal(dY.id.toNumber());
  });
});
