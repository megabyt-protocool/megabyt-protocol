import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  mintTo,
} from "@solana/spl-token";
import {
  SystemProgram,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

/**
 * Valida a ETAPA 3 (cartela de tamanho variável, opção A — só os números
 * variam; crypto continua 1 até a Etapa 4):
 *
 *  1. Com o teto (global_state.numbers_count) em 10: cartelas de 6/7/8/10
 *     números são aceitas; 5 (< DRAWN_NUMBERS) e 11 (> teto) são rejeitadas.
 *  2. set_numbers_count (mirror de set_crypto_count) muda o teto
 *     corretamente, rejeita valor fora de 6..25 (DRAWN_NUMBERS..
 *     Ticket::MAX_NUMBERS) e rejeita chamador que não é admin.
 *  3. Bônus end-to-end (fecha o loop com a Etapa 1): uma cartela de 8
 *     números CONTENDO os 6 sorteados + a crypto certa vence o JACKPOT
 *     (tier 0) de verdade via settle_tickets on-chain — não só no teste
 *     unitário puro de scoring.rs.
 *
 * Nomeado pra ordenar DEPOIS de tests/set_crypto_count.ts (mesma lição das
 * sub-etapas anteriores: reaproveita o global_state/vaults já
 * inicializados por outro arquivo da suíte).
 */
describe("numbers_count e cartela de tamanho variável (Etapa 3)", () => {
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

  function getDrawPDA(drawId: number | anchor.BN): PublicKey {
    const bn = new anchor.BN(drawId);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("draw-v3"), bn.toArrayLike(Buffer, "le", 8)],
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

  async function openDrawOnly(): Promise<{ id: anchor.BN; pda: PublicKey }> {
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

  async function buyTicket(
    drawPda: PublicKey,
    numbers: number[],
    crypto: number
  ): Promise<{ kp: Keypair; ticketPda: PublicKey }> {
    const { kp, ata } = await fundWallet(mint, ticketPrice.toNumber() * 2);
    const ticketPda = getTicketPDA(drawPda, kp.publicKey, 0);
    const userDrawState = getUserDrawStatePDA(drawPda, kp.publicKey);
    const userGlobalStateAcc = getUserGlobalStatePDA(kp.publicKey);

    await (program.methods
      .buyTicket(Buffer.from(numbers), Buffer.from([crypto]))
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

    return { kp, ticketPda };
  }

  let mint: PublicKey;
  let ticketPrice: anchor.BN;
  let originalNumbersCount: number;

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

    originalNumbersCount = Number(globalAccount.numbersCount);
    console.log(`    [setup] numbersCount original=${originalNumbersCount} cryptoCount=${globalAccount.cryptoCount}`);

    // Teto de 10 pro resto deste arquivo — folga suficiente pra testar
    // 6/7/8/10 (aceitos) e 5/11 (rejeitados) sem depender de em qual fase
    // os arquivos anteriores da suíte deixaram o protocolo.
    await (program.methods
      .setNumbersCount(10)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();
  });

  after(async () => {
    // Restaura o teto original antes dos próximos arquivos da suíte.
    await (program.methods
      .setNumbersCount(originalNumbersCount)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();
  });

  it("aceita cartelas de 6, 7, 8 e 10 números com teto=10", async () => {
    const draw = await openDrawOnly();

    for (const len of [6, 7, 8, 10]) {
      const numbers = Array.from({ length: len }, (_, i) => i + 1);
      const { ticketPda } = await buyTicket(draw.pda, numbers, 1);
      const ticket: any = await program.account.ticket.fetch(ticketPda);
      expect(ticket.numbers.length).to.equal(len);
    }
  });

  it("rejeita cartela de 5 números (< DRAWN_NUMBERS)", async () => {
    const draw = await openDrawOnly();
    const numbers = [1, 2, 3, 4, 5];

    let threw = false;
    let errText = "";
    try {
      await buyTicket(draw.pda, numbers, 1);
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "cartela de 5 deveria ser rejeitada");
    expect(errText).to.match(/InvalidNumbersCount/);
  });

  it("rejeita cartela de 11 números (> teto=10)", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: 11 }, (_, i) => i + 1);

    let threw = false;
    let errText = "";
    try {
      await buyTicket(draw.pda, numbers, 1);
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "cartela de 11 deveria ser rejeitada com teto=10");
    expect(errText).to.match(/InvalidNumbersCount/);
  });

  it("set_numbers_count muda o valor corretamente", async () => {
    await (program.methods
      .setNumbersCount(15)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();

    let gs: any = await program.account.globalState.fetch(globalState);
    expect(gs.numbersCount).to.equal(15);

    // Restaura pra 10 (usado pelo resto deste arquivo).
    await (program.methods
      .setNumbersCount(10)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();

    gs = await program.account.globalState.fetch(globalState);
    expect(gs.numbersCount).to.equal(10);
  });

  it("set_numbers_count rejeita valor fora de 6..25", async () => {
    for (const bad of [5, 26]) {
      let threw = false;
      let errText = "";
      try {
        await (program.methods
          .setNumbersCount(bad)
          .accounts as any)({
            admin: admin.publicKey,
            globalState,
          }).rpc();
      } catch (e: any) {
        threw = true;
        errText = e?.message || String(e);
      }
      expect(threw).to.equal(true, `numbers_count=${bad} deveria ser rejeitado`);
      expect(errText).to.match(/InvalidNumbersCount/);
    }

    const gs: any = await program.account.globalState.fetch(globalState);
    expect(gs.numbersCount).to.equal(10, "valor invalido nao deveria ter sido gravado");
  });

  it("set_numbers_count rejeita chamador que não é admin", async () => {
    const fakeAdmin = Keypair.generate();
    const sig = await connection.requestAirdrop(fakeAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .setNumbersCount(8)
        .accounts as any)({
          admin: fakeAdmin.publicKey,
          globalState,
        }).signers([fakeAdmin]).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "chamador nao-admin deveria ser rejeitado");
    expect(errText).to.match(/Unauthorized|has_one|ConstraintHasOne/);

    const gs: any = await program.account.globalState.fetch(globalState);
    expect(gs.numbersCount).to.equal(10, "nao deveria ter mudado");
  });

  it("BÔNUS E2E (fecha o loop com a Etapa 1): cartela de 8 cobrindo os 6 sorteados + crypto certa ganha o JACKPOT (tier 0) de verdade", async function () {
    this.timeout(60_000);

    // ---- Descoberta: sorteio descartável só pra saber o resultado
    // determinístico do VRF em modo teste (mesma técnica de
    // tests/pay_winners_batch.ts — o seed é fixo, independente da draw).
    const discovery = await openDrawOnly();
    await buyTicket(discovery.pda, [1, 2, 3, 4, 5, 6], 1);

    const randomnessKp1 = Keypair.generate();
    await (program.methods
      .requestRandomness()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: discovery.pda,
        randomnessAccount: randomnessKp1.publicKey,
      }).rpc();

    await (program.methods
      .closeDraw()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: discovery.pda,
        randomnessAccountData: randomnessKp1.publicKey,
      }).preInstructions([CU_LIMIT_IX]).rpc();

    const discoveryDraw: any = await program.account.draw.fetch(discovery.pda);
    const resultNumbers = Array.from(discoveryDraw.resultNumbers as Iterable<number>, (n) => Number(n));
    const resultCrypto = Number(discoveryDraw.resultCrypto);
    expect(resultNumbers.length).to.equal(6);
    console.log(`    [discovery] resultNumbers=${resultNumbers} resultCrypto=${resultCrypto}`);

    // ---- Sorteio real: cartela de 8 = os 6 sorteados + 2 números extras
    // que a cartela nunca precisaria acertar (o tamanho da cartela é
    // vantagem, não penalidade — ver scoring::resolve_tier / Etapa 1).
    const real = await openDrawOnly();
    let extra = 1;
    const cartela = [...resultNumbers];
    while (cartela.length < 8) {
      if (!resultNumbers.includes(extra)) cartela.push(extra);
      extra++;
    }
    expect(cartela.length).to.equal(8);

    const { ticketPda } = await buyTicket(real.pda, cartela, resultCrypto);

    const randomnessKp2 = Keypair.generate();
    await (program.methods
      .requestRandomness()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: real.pda,
        randomnessAccount: randomnessKp2.publicKey,
      }).rpc();

    await (program.methods
      .closeDraw()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: real.pda,
        randomnessAccountData: randomnessKp2.publicKey,
      }).preInstructions([CU_LIMIT_IX]).rpc();

    const realDraw: any = await program.account.draw.fetch(real.pda);
    const gotNumbers = Array.from(realDraw.resultNumbers as Iterable<number>, (n) => Number(n));
    expect(gotNumbers).to.deep.equal(resultNumbers, "seed determinístico deveria repetir o mesmo resultado");

    await (program.methods
      .settleTickets(1)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: real.pda,
      }).remainingAccounts([
        { pubkey: ticketPda, isWritable: true, isSigner: false },
      ]).preInstructions([CU_LIMIT_IX]).rpc();

    const ticket: any = await program.account.ticket.fetch(ticketPda);
    expect(ticket.numbers.length).to.equal(8, "a cartela de 8 números deveria ter sido preservada");
    expect(Number(ticket.tier)).to.equal(0, "cartela de 8 cobrindo os 6 sorteados + crypto certa deveria ser JACKPOT (tier 0)");
  });
});
