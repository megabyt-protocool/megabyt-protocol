import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo } from "@solana/spl-token";
import {
  SystemProgram,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

/**
 * Valida a Sub-etapa 3B: request_monthly_randomness + close_monthly_draw.
 * Nenhuma lógica de settle/finalize/pay mensal existe ainda.
 *
 *  1. O sorteio mensal usa o MESMO seed determinístico de teste do diário
 *     (feature "testing") e produz o MESMO resultado (números + crypto) —
 *     confirma na prática o que os testes de paridade em Rust
 *     (randomness.rs, `cargo test`) já garantem no nível de função.
 *  2. Split da cascata: tier 0 = jackpot_pool inteiro; tiers 1..9 =
 *     cascade_pool fatiado pelos pesos renormalizados, batendo o cálculo
 *     feito aqui de forma independente.
 *  3. Transição de status 0 -> 1 em close_monthly_draw.
 *  4. Guards: anti-replay (request duas vezes falha), close sem request
 *     falha, close depois de já fechado falha.
 *
 * Independente dos outros arquivos: reaproveita global_state, vaults,
 * monthly_state e monthly_vault se já existirem na mesma validator.
 */
describe("close_monthly_draw — Sub-etapa 3B (VRF do mensal)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const CU_LIMIT_IX = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  // Mesmos pesos de MONTHLY_CASCADE_TIER_BPS em close_monthly_draw.rs —
  // recalculados aqui de forma independente pra conferir o split.
  const MONTHLY_CASCADE_TIER_BPS = [1200, 800, 600, 500, 400, 300, 300, 250, 150];
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

  async function closeDrawFor(draw: DrawRef): Promise<[number[], number]> {
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

    const drawAccount: any = await program.account.draw.fetch(draw.pda);
    return [
      Array.from(drawAccount.resultNumbers as Iterable<number>, (n) => Number(n)),
      Number(drawAccount.resultCrypto),
    ];
  }

  async function openBuyCloseDraw(): Promise<DrawRef> {
    const d = await openDrawOnly();
    await buyOneTicket(d.pda);
    await closeDrawFor(d);
    return d;
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

    console.log(`    [setup] mint=${mint.toBase58()} ticketPrice=${ticketPrice.toString()} numbersCount=${numbersCount}`);
  });

  let discoveryResultNumbers: number[];
  let discoveryResultCrypto: number;

  it("descobre o resultado determinístico do seed de teste via um sorteio diário descartável", async () => {
    const d = await openDrawOnly();
    await buyOneTicket(d.pda);
    const [numbers, crypto] = await closeDrawFor(d);
    discoveryResultNumbers = numbers;
    discoveryResultCrypto = crypto;

    // Etapa 2: sorteio sempre 6 números (DRAWN_NUMBERS), qualquer fase.
    expect(discoveryResultNumbers.length).to.equal(6);
    expect(new Set(discoveryResultNumbers).size).to.equal(6);
    // Crypto continua sorteada normalmente: 1 valor em 1..=10.
    expect(discoveryResultCrypto).to.be.within(1, 10);
    console.log(`    [discovery] resultNumbers=${discoveryResultNumbers} resultCrypto=${discoveryResultCrypto}`);
  });

  let d1: DrawRef, d2: DrawRef;
  let monthlyDrawPda: PublicKey;
  let jackpotPool: bigint, cascadePool: bigint;

  it("abre um sorteio mensal cobrindo 2 draws diárias, pra servir de base ao VRF mensal", async () => {
    d1 = await openBuyCloseDraw();
    d2 = await openBuyCloseDraw();

    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    monthlyDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    // Contiguidade: se já existe um mês anterior (de outro arquivo de
    // teste), o range precisa começar logo depois dele. Como só
    // controlamos d1/d2 aqui, cobrimos exatamente esse par.
    await (program.methods
      .openMonthlyDraw(d1.id, d2.id)
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
      }).remainingAccounts([
        { pubkey: d1.pda, isWritable: false, isSigner: false },
        { pubkey: d2.pda, isWritable: false, isSigner: false },
      ]).rpc();

    const monthlyDraw: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(monthlyDraw.status)).to.equal(0);
    jackpotPool = BigInt(monthlyDraw.jackpotPool.toString());
    cascadePool = BigInt(monthlyDraw.cascadePool.toString());
  });

  it("close_monthly_draw sem request_monthly_randomness antes falha", async () => {
    const randomnessKp = Keypair.generate();
    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .closeMonthlyDraw()
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyDraw: monthlyDrawPda,
          randomnessAccountData: randomnessKp.publicKey,
        }).preInstructions([CU_LIMIT_IX]).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }
    expect(threw).to.equal(true, "close_monthly_draw sem request antes deveria falhar");
    expect(errText).to.match(/InvalidDrawState/);
  });

  let randomnessKp: Keypair;

  it("request_monthly_randomness: registra a conta e não mexe em status", async () => {
    randomnessKp = Keypair.generate();

    const before: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(before.randomnessRequested).to.equal(false);

    await (program.methods
      .requestMonthlyRandomness()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyDraw: monthlyDrawPda,
        randomnessAccount: randomnessKp.publicKey,
      }).rpc();

    const after: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(after.randomnessRequested).to.equal(true);
    expect(after.randomnessAccount.toBase58()).to.equal(randomnessKp.publicKey.toBase58());
    expect(Number(after.commitSlot)).to.be.greaterThan(0);
    expect(Number(after.status)).to.equal(0, "request não deve mudar o status");
  });

  it("request_monthly_randomness de novo (anti-replay) falha", async () => {
    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .requestMonthlyRandomness()
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyDraw: monthlyDrawPda,
          randomnessAccount: Keypair.generate().publicKey,
        }).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }
    expect(threw).to.equal(true, "segundo request deveria ser rejeitado (anti-replay)");
    expect(errText).to.match(/InvalidDrawState/);
  });

  it("close_monthly_draw: sorteia o MESMO resultado do diário, divide a cascata certo, status 0 -> 1", async () => {
    await (program.methods
      .closeMonthlyDraw()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyDraw: monthlyDrawPda,
        randomnessAccountData: randomnessKp.publicKey,
      }).preInstructions([CU_LIMIT_IX]).rpc();

    const monthlyDraw: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);

    // 1. Mesmo seed de teste => mesmo resultado do diário (confirma na
    // prática a paridade já garantida pelos testes de Rust).
    const gotNumbers = Array.from(monthlyDraw.resultNumbers as Iterable<number>, (n: any) => Number(n));
    expect(gotNumbers).to.deep.equal(
      discoveryResultNumbers,
      "sorteio mensal produziu números DIFERENTES do diário pro mesmo seed de teste"
    );
    expect(Number(monthlyDraw.resultCrypto)).to.equal(discoveryResultCrypto);
    expect(monthlyDraw.randomnessFulfilled).to.equal(true);

    // 2. Split da cascata.
    const prizePerTier: bigint[] = monthlyDraw.monthlyPrizePerTier.map((x: any) => BigInt(x.toString()));
    expect(prizePerTier[0]).to.equal(jackpotPool, "tier 0 deveria ser o jackpot_pool inteiro");

    let sumCascade = 0n;
    for (let i = 0; i < 9; i++) {
      const tier = i + 1;
      const expected = (cascadePool * BigInt(MONTHLY_CASCADE_TIER_BPS[i])) / MONTHLY_CASCADE_BPS_SUM;
      expect(prizePerTier[tier]).to.equal(expected, `tier ${tier} nao bate com o peso renormalizado`);
      sumCascade += prizePerTier[tier];
    }
    expect(sumCascade <= cascadePool).to.equal(true, "soma dos tiers de cascata nao pode passar do cascade_pool");

    // 3. winner_counts zerado.
    for (const c of monthlyDraw.monthlyWinnerCounts) {
      expect(Number(c)).to.equal(0);
    }

    // 4. status 0 -> 1.
    expect(Number(monthlyDraw.status)).to.equal(1);
  });

  it("close_monthly_draw de novo (já fechado, status != 0) falha", async () => {
    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .closeMonthlyDraw()
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyDraw: monthlyDrawPda,
          randomnessAccountData: randomnessKp.publicKey,
        }).preInstructions([CU_LIMIT_IX]).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }
    expect(threw).to.equal(true, "close_monthly_draw num sorteio ja fechado deveria falhar");
    expect(errText).to.match(/DrawNotReady/);
  });
});
