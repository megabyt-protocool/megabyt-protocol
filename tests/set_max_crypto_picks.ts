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
 * Valida a ETAPA 4, sub-etapa 4b (cartela multi-crypto — só a ESTRUTURA e
 * o critério de vitória; preço e multiplicidade de prêmio ficam pra 4c/4d/4e):
 *
 *  1. Com o teto (max_crypto_picks) em 3: cartelas com 1/2/3 cryptos são
 *     aceitas; 0 (vazia) e 4 (acima do teto) são rejeitadas; crypto
 *     duplicada e fora do range 1..crypto_count (10) são rejeitadas.
 *  2. set_max_crypto_picks (mirror de set_numbers_count) muda o teto
 *     corretamente, rejeita valor fora de 1..10 e rejeita não-admin.
 *  3. crypto_hit acerta se QUALQUER uma das cryptos escolhidas bater com
 *     a sorteada (não precisa ser uma específica) — provado on-chain via
 *     settle_tickets, com controle negativo (nenhuma bate).
 *  4. Cobertura nova (achado da sub-etapa 4b): `buy_ticket_with_referral`
 *     e `claim_bonus_ticket` não tinham NENHUM teste na suíte `make test`
 *     antes desta sub-etapa — agora aceitam `cryptos: Vec<u8>` e ganham
 *     cobertura mínima aqui.
 *
 * Nomeado pra ordenar DEPOIS de tests/set_crypto_count.ts (mesma lição
 * das sub-etapas anteriores: reaproveita o global_state/vaults já
 * inicializados por outro arquivo da suíte).
 */
describe("cartela multi-crypto (Etapa 4, sub-etapa 4b)", () => {
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

  function getUserStatePDA(owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user-state-v3"), owner.toBuffer()],
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
    cryptos: number[]
  ): Promise<{ kp: Keypair; ticketPda: PublicKey }> {
    const { kp, ata } = await fundWallet(mint, ticketPrice.toNumber() * 2);
    const ticketPda = getTicketPDA(drawPda, kp.publicKey, 0);
    const userDrawState = getUserDrawStatePDA(drawPda, kp.publicKey);
    const userGlobalStateAcc = getUserGlobalStatePDA(kp.publicKey);

    await (program.methods
      .buyTicket(Buffer.from(numbers), Buffer.from(cryptos))
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

  /** Primeiro ID de crypto (1..10) que NÃO está em `exclude`. */
  function otherCrypto(exclude: number[]): number {
    for (let c = 1; c <= 10; c++) {
      if (!exclude.includes(c)) return c;
    }
    throw new Error("otherCrypto: nenhum ID livre em 1..10");
  }

  let mint: PublicKey;
  let ticketPrice: anchor.BN;
  let numbersCount: number;
  let originalMaxCryptoPicks: number;

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
    originalMaxCryptoPicks = Number(globalAccount.maxCryptoPicks);
    console.log(`    [setup] numbersCount=${numbersCount} cryptoCount=${globalAccount.cryptoCount} maxCryptoPicks original=${originalMaxCryptoPicks}`);
    expect(originalMaxCryptoPicks).to.equal(1, "max_crypto_picks deveria nascer em 1 no initialize");

    // Teto de 3 pro resto deste arquivo — folga suficiente pra testar
    // 1/2/3 (aceitos) e 0/4 (rejeitados).
    await (program.methods
      .setMaxCryptoPicks(3)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();
  });

  after(async () => {
    // Restaura o teto original antes dos próximos arquivos da suíte.
    await (program.methods
      .setMaxCryptoPicks(originalMaxCryptoPicks)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();
  });

  it("aceita 1 crypto (como hoje)", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);
    const { ticketPda } = await buyTicket(draw.pda, numbers, [7]);
    const ticket: any = await program.account.ticket.fetch(ticketPda);
    expect(Array.from(ticket.cryptos as Iterable<number>, (n) => Number(n))).to.deep.equal([7]);
  });

  it("aceita 2 e 3 cryptos com teto=3", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    const { ticketPda: t2 } = await buyTicket(draw.pda, numbers, [3, 7]);
    const ticket2: any = await program.account.ticket.fetch(t2);
    expect(Array.from(ticket2.cryptos as Iterable<number>, (n) => Number(n))).to.deep.equal([3, 7]);

    const { ticketPda: t3 } = await buyTicket(draw.pda, numbers, [1, 5, 9]);
    const ticket3: any = await program.account.ticket.fetch(t3);
    expect(Array.from(ticket3.cryptos as Iterable<number>, (n) => Number(n))).to.deep.equal([1, 5, 9]);
  });

  it("rejeita lista vazia de cryptos", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    let threw = false;
    let errText = "";
    try {
      await buyTicket(draw.pda, numbers, []);
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }
    expect(threw).to.equal(true, "lista vazia deveria ser rejeitada");
    expect(errText).to.match(/InvalidCryptoCount/);
  });

  it("rejeita mais cryptos que o teto (4 > 3)", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    let threw = false;
    let errText = "";
    try {
      await buyTicket(draw.pda, numbers, [1, 2, 3, 4]);
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }
    expect(threw).to.equal(true, "4 cryptos com teto=3 deveria ser rejeitado");
    expect(errText).to.match(/InvalidCryptoCount/);
  });

  it("rejeita crypto duplicada", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    let threw = false;
    let errText = "";
    try {
      await buyTicket(draw.pda, numbers, [7, 7]);
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }
    expect(threw).to.equal(true, "crypto duplicada deveria ser rejeitada");
    expect(errText).to.match(/DuplicateCrypto/);
  });

  it("rejeita crypto fora do range 1..crypto_count (10)", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    for (const bad of [[11], [0]]) {
      let threw = false;
      let errText = "";
      try {
        await buyTicket(draw.pda, numbers, bad);
      } catch (e: any) {
        threw = true;
        errText = e?.message || String(e);
      }
      expect(threw).to.equal(true, `crypto=${bad} deveria ser rejeitada`);
      expect(errText).to.match(/InvalidCryptoNumber/);
    }
  });

  it("set_max_crypto_picks muda o valor corretamente", async () => {
    await (program.methods
      .setMaxCryptoPicks(5)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();

    let gs: any = await program.account.globalState.fetch(globalState);
    expect(gs.maxCryptoPicks).to.equal(5);

    // Restaura pra 3 (usado pelo resto deste arquivo).
    await (program.methods
      .setMaxCryptoPicks(3)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();

    gs = await program.account.globalState.fetch(globalState);
    expect(gs.maxCryptoPicks).to.equal(3);
  });

  it("set_max_crypto_picks rejeita valor fora de 1..10", async () => {
    for (const bad of [0, 11]) {
      let threw = false;
      let errText = "";
      try {
        await (program.methods
          .setMaxCryptoPicks(bad)
          .accounts as any)({
            admin: admin.publicKey,
            globalState,
          }).rpc();
      } catch (e: any) {
        threw = true;
        errText = e?.message || String(e);
      }
      expect(threw).to.equal(true, `max_crypto_picks=${bad} deveria ser rejeitado`);
      expect(errText).to.match(/InvalidCryptoCount/);
    }

    const gs: any = await program.account.globalState.fetch(globalState);
    expect(gs.maxCryptoPicks).to.equal(3, "valor invalido nao deveria ter sido gravado");
  });

  it("set_max_crypto_picks rejeita chamador que não é admin", async () => {
    const fakeAdmin = Keypair.generate();
    const sig = await connection.requestAirdrop(fakeAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .setMaxCryptoPicks(2)
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
    expect(gs.maxCryptoPicks).to.equal(3, "nao deveria ter mudado");
  });

  it("crypto_hit acerta se QUALQUER uma das escolhidas bater (via settle_tickets on-chain)", async function () {
    this.timeout(60_000);

    // ---- Descoberta: sorteio descartável só pra saber o resultado
    // determinístico do VRF em modo teste (mesma técnica das sub-etapas
    // anteriores — o seed é fixo, independente da draw).
    const discovery = await openDrawOnly();
    await buyTicket(discovery.pda, [1, 2, 3, 4, 5, 6], [1]);

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
    console.log(`    [discovery] resultNumbers=${resultNumbers} resultCrypto=${resultCrypto}`);

    // ---- Sorteio real: 2 tickets com os mesmos 6 números (hits=6,
    // deficit=0), cada um com 2 cryptos escolhidas —
    //   ticket A: UMA das 2 escolhidas é a sorteada (deveria dar tier PAR)
    //   ticket B: NENHUMA das 2 escolhidas é a sorteada (controle
    //             negativo — deveria dar tier ÍMPAR)
    const outraCrypto = otherCrypto([resultCrypto]);
    const duasErradas = [otherCrypto([resultCrypto]), otherCrypto([resultCrypto, outraCrypto])];

    const real = await openDrawOnly();
    const { ticketPda: ticketA } = await buyTicket(real.pda, resultNumbers, [resultCrypto, outraCrypto]);
    const { ticketPda: ticketB } = await buyTicket(real.pda, resultNumbers, duasErradas);

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
      .settleTickets(2)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: real.pda,
      }).remainingAccounts([
        { pubkey: ticketA, isWritable: true, isSigner: false },
        { pubkey: ticketB, isWritable: true, isSigner: false },
      ]).preInstructions([CU_LIMIT_IX]).rpc();

    const ticketAAccount: any = await program.account.ticket.fetch(ticketA);
    const ticketBAccount: any = await program.account.ticket.fetch(ticketB);

    expect(Number(ticketAAccount.tier) % 2).to.equal(0, "ticket A: uma das 2 cryptos bateu -> tier PAR (crypto certa)");
    expect(Number(ticketAAccount.tier)).to.equal(0, "6 acertos + crypto certa = jackpot (tier 0)");

    expect(Number(ticketBAccount.tier) % 2).to.equal(1, "ticket B: nenhuma das 2 cryptos bateu -> tier ÍMPAR");
    expect(Number(ticketBAccount.tier)).to.equal(1, "6 acertos sem crypto certa = tier 1");
  });

  it("buy_ticket_with_referral aceita cryptos: Vec<u8> (cobertura nova — não existia antes da 4b)", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    const { kp: referrerKp, ata: referrerAta } = await fundWallet(mint, 0);
    await (program.methods
      .initUserState()
      .accounts as any)({
        user: referrerKp.publicKey,
        userState: getUserStatePDA(referrerKp.publicKey),
        systemProgram: SystemProgram.programId,
      }).signers([referrerKp]).rpc();

    const { kp: userKp, ata: userAta } = await fundWallet(mint, ticketPrice.toNumber() * 2);
    await (program.methods
      .initUserState()
      .accounts as any)({
        user: userKp.publicKey,
        userState: getUserStatePDA(userKp.publicKey),
        systemProgram: SystemProgram.programId,
      }).signers([userKp]).rpc();

    await (program.methods
      .setReferrer()
      .accounts as any)({
        user: userKp.publicKey,
        userState: getUserStatePDA(userKp.publicKey),
        referrerState: getUserStatePDA(referrerKp.publicKey),
      }).signers([userKp]).rpc();

    const ticketPda = getTicketPDA(draw.pda, userKp.publicKey, 0);

    await (program.methods
      .buyTicketWithReferral(Buffer.from(numbers), Buffer.from([2, 8]))
      .accounts as any)({
        user: userKp.publicKey,
        globalState,
        drawState: draw.pda,
        userDrawState: getUserDrawStatePDA(draw.pda, userKp.publicKey),
        userGlobalState: getUserGlobalStatePDA(userKp.publicKey),
        ticket: ticketPda,
        userTokenAccount: userAta,
        prizeVault,
        userState: getUserStatePDA(userKp.publicKey),
        referrerState: getUserStatePDA(referrerKp.publicKey),
        referrerTokenAccount: referrerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([userKp]).rpc();

    const ticket: any = await program.account.ticket.fetch(ticketPda);
    expect(Array.from(ticket.cryptos as Iterable<number>, (n) => Number(n))).to.deep.equal([2, 8]);
  });

  it("claim_bonus_ticket aceita cryptos: Vec<u8> (cobertura nova — não existia antes da 4b)", async () => {
    // Precisa de 2 conversões de referral pra gerar 1 credito de bonus
    // (regra existente: a cada 2 successful_referrals, +1 bonus_ticket_credits).
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    const { kp: referrerKp, ata: referrerAta } = await fundWallet(mint, 0);
    await (program.methods
      .initUserState()
      .accounts as any)({
        user: referrerKp.publicKey,
        userState: getUserStatePDA(referrerKp.publicKey),
        systemProgram: SystemProgram.programId,
      }).signers([referrerKp]).rpc();

    for (let i = 0; i < 2; i++) {
      const { kp: userKp, ata: userAta } = await fundWallet(mint, ticketPrice.toNumber() * 2);
      await (program.methods
        .initUserState()
        .accounts as any)({
          user: userKp.publicKey,
          userState: getUserStatePDA(userKp.publicKey),
          systemProgram: SystemProgram.programId,
        }).signers([userKp]).rpc();

      await (program.methods
        .setReferrer()
        .accounts as any)({
          user: userKp.publicKey,
          userState: getUserStatePDA(userKp.publicKey),
          referrerState: getUserStatePDA(referrerKp.publicKey),
        }).signers([userKp]).rpc();

      const ticketPda = getTicketPDA(draw.pda, userKp.publicKey, 0);
      await (program.methods
        .buyTicketWithReferral(Buffer.from(numbers), Buffer.from([1]))
        .accounts as any)({
          user: userKp.publicKey,
          globalState,
          drawState: draw.pda,
          userDrawState: getUserDrawStatePDA(draw.pda, userKp.publicKey),
          userGlobalState: getUserGlobalStatePDA(userKp.publicKey),
          ticket: ticketPda,
          userTokenAccount: userAta,
          prizeVault,
          userState: getUserStatePDA(userKp.publicKey),
          referrerState: getUserStatePDA(referrerKp.publicKey),
          referrerTokenAccount: referrerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([userKp]).rpc();
    }

    const referrerState: any = await program.account.userState.fetch(getUserStatePDA(referrerKp.publicKey));
    expect(referrerState.bonusTicketCredits).to.equal(1, "2 conversões deveriam gerar 1 crédito de bônus");

    const bonusTicketPda = getTicketPDA(draw.pda, referrerKp.publicKey, 0);
    await (program.methods
      .claimBonusTicket(Buffer.from(numbers), Buffer.from([4, 6, 9]))
      .accounts as any)({
        user: referrerKp.publicKey,
        globalState,
        userState: getUserStatePDA(referrerKp.publicKey),
        drawState: draw.pda,
        userDrawState: getUserDrawStatePDA(draw.pda, referrerKp.publicKey),
        ticket: bonusTicketPda,
        systemProgram: SystemProgram.programId,
      }).signers([referrerKp]).rpc();

    const bonusTicket: any = await program.account.ticket.fetch(bonusTicketPda);
    expect(Array.from(bonusTicket.cryptos as Iterable<number>, (n) => Number(n))).to.deep.equal([4, 6, 9]);
  });
});
