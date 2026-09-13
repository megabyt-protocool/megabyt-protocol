import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import {
  SystemProgram,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

/**
 * Valida a ETAPA 4, sub-etapa 4c (preço combinatório) — só o VALOR
 * cobrado na compra muda; tier/settle/pay continuam intocados (isso é
 * a 4d/4e).
 *
 *  1. preço(n, k) = C(n,6) × k × ticket_price (a "base" de 1 aposta):
 *     6+1crypto = 1×base, 6+2cryptos = 2×base, 7+1crypto = 7×base,
 *     8+1crypto = 28×base, 8+2cryptos = 56×base.
 *  2. Saldo insuficiente pro preço CALCULADO (não mais o fixo) é
 *     rejeitado.
 *  3. `buy_ticket_with_referral`: o split 5%/95% (referral/prize)
 *     escala sobre o preço combinatório, não sobre o ticket_price fixo.
 *
 * Nomeado pra ordenar DEPOIS de tests/pay_winners_batch.ts e ANTES dos
 * arquivos set_*.ts — não depende de nenhum deles, só levanta o teto de
 * numbers_count/max_crypto_picks localmente (restaura no fim).
 */
describe("preço combinatório C(n,6) × k (Etapa 4, sub-etapa 4c)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

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

  /** C(n,6) via a mesma formula multiplicativa do programa (JS, só pra montar o esperado no teste). */
  function binomial6(n: number): bigint {
    const DRAWN = 6n;
    let nBig = BigInt(n);
    if (nBig < DRAWN) return 0n;
    let result = 1n;
    for (let i = 0n; i < DRAWN; i++) {
      result = (result * (nBig - i)) / (i + 1n);
    }
    return result;
  }

  function expectedPrice(n: number, k: number, base: bigint): bigint {
    return binomial6(n) * BigInt(k) * base;
  }

  async function fundWallet(
    mintPk: PublicKey,
    tokenAmount: bigint
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

  let mint: PublicKey;
  let ticketPrice: anchor.BN;
  let base: bigint;
  let originalNumbersCount: number;
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

    base = BigInt(ticketPrice.toString());
    originalNumbersCount = Number(globalAccount.numbersCount);
    originalMaxCryptoPicks = Number(globalAccount.maxCryptoPicks);
    console.log(`    [setup] base(ticketPrice)=${base} numbersCount original=${originalNumbersCount} maxCryptoPicks original=${originalMaxCryptoPicks}`);

    // Teto de 8 números / 2 cryptos pro resto deste arquivo — cobre toda
    // a tabela da spec (6, 7, 8 números; 1, 2 cryptos).
    await (program.methods.setNumbersCount(8).accounts as any)({ admin: admin.publicKey, globalState }).rpc();
    await (program.methods.setMaxCryptoPicks(2).accounts as any)({ admin: admin.publicKey, globalState }).rpc();
  });

  after(async () => {
    await (program.methods.setNumbersCount(originalNumbersCount).accounts as any)({ admin: admin.publicKey, globalState }).rpc();
    await (program.methods.setMaxCryptoPicks(originalMaxCryptoPicks).accounts as any)({ admin: admin.publicKey, globalState }).rpc();
  });

  /** Compra 1 ticket e retorna quanto foi debitado da carteira do comprador. */
  async function buyAndMeasureDebit(
    drawPda: PublicKey,
    numbers: number[],
    cryptos: number[]
  ): Promise<bigint> {
    // Funda generosamente (bem acima do pior caso desta tabela: 56×base)
    // pra nenhuma compra falhar por saldo — o saldo insuficiente tem teste próprio.
    const { kp, ata } = await fundWallet(mint, base * 1000n);
    const before = await getAccount(connection, ata);

    const ticketPda = getTicketPDA(drawPda, kp.publicKey, 0);
    await (program.methods
      .buyTicket(Buffer.from(numbers), Buffer.from(cryptos))
      .accounts as any)({
        user: kp.publicKey,
        globalState,
        drawState: drawPda,
        userDrawState: getUserDrawStatePDA(drawPda, kp.publicKey),
        userGlobalState: getUserGlobalStatePDA(kp.publicKey),
        ticket: ticketPda,
        userTokenAccount: ata,
        prizeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([kp]).rpc();

    const after = await getAccount(connection, ata);
    return before.amount - after.amount;
  }

  it("6 números + 1 crypto custa 1× base", async () => {
    const draw = await openDrawOnly();
    const debited = await buyAndMeasureDebit(draw.pda, [1, 2, 3, 4, 5, 6], [7]);
    expect(debited).to.equal(expectedPrice(6, 1, base));
    expect(debited).to.equal(base);
  });

  it("6 números + 2 cryptos custa 2× base", async () => {
    const draw = await openDrawOnly();
    const debited = await buyAndMeasureDebit(draw.pda, [1, 2, 3, 4, 5, 6], [3, 7]);
    expect(debited).to.equal(expectedPrice(6, 2, base));
    expect(debited).to.equal(base * 2n);
  });

  it("7 números + 1 crypto custa 7× base", async () => {
    const draw = await openDrawOnly();
    const debited = await buyAndMeasureDebit(draw.pda, [1, 2, 3, 4, 5, 6, 7], [7]);
    expect(debited).to.equal(expectedPrice(7, 1, base));
    expect(debited).to.equal(base * 7n);
  });

  it("8 números + 1 crypto custa 28× base", async () => {
    const draw = await openDrawOnly();
    const debited = await buyAndMeasureDebit(draw.pda, [1, 2, 3, 4, 5, 6, 7, 8], [7]);
    expect(debited).to.equal(expectedPrice(8, 1, base));
    expect(debited).to.equal(base * 28n);
  });

  it("8 números + 2 cryptos custa 56× base", async () => {
    const draw = await openDrawOnly();
    const debited = await buyAndMeasureDebit(draw.pda, [1, 2, 3, 4, 5, 6, 7, 8], [3, 7]);
    expect(debited).to.equal(expectedPrice(8, 2, base));
    expect(debited).to.equal(base * 56n);
  });

  it("saldo insuficiente pro preço CALCULADO é rejeitado (não mais o ticket_price fixo)", async () => {
    const draw = await openDrawOnly();
    // 8 números + 1 crypto custa 28×base — funda só com 10×base, que
    // seria de sobra no modelo antigo (preço fixo) mas não cobre o preço
    // combinatório de verdade.
    const { kp, ata } = await fundWallet(mint, base * 10n);
    const ticketPda = getTicketPDA(draw.pda, kp.publicKey, 0);

    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .buyTicket(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), Buffer.from([7]))
        .accounts as any)({
          user: kp.publicKey,
          globalState,
          drawState: draw.pda,
          userDrawState: getUserDrawStatePDA(draw.pda, kp.publicKey),
          userGlobalState: getUserGlobalStatePDA(kp.publicKey),
          ticket: ticketPda,
          userTokenAccount: ata,
          prizeVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([kp]).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "10×base não cobre o preço real de 28×base — deveria ser rejeitado");
    expect(errText).to.match(/InvalidTicket/);
  });

  it("buy_ticket_with_referral: referral (5%) e prize (95%) escalam sobre o preço combinatório", async () => {
    const draw = await openDrawOnly();
    const price = expectedPrice(7, 1, base); // 7× base
    const expectedReferral = (price * 5n) / 100n;
    const expectedPrizeAmount = price - expectedReferral;

    const { kp: referrerKp, ata: referrerAta } = await fundWallet(mint, 0n);
    await (program.methods
      .initUserState()
      .accounts as any)({
        user: referrerKp.publicKey,
        userState: getUserStatePDA(referrerKp.publicKey),
        systemProgram: SystemProgram.programId,
      }).signers([referrerKp]).rpc();

    const { kp: userKp, ata: userAta } = await fundWallet(mint, base * 1000n);
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

    const referrerBefore = await getAccount(connection, referrerAta);
    const userBefore = await getAccount(connection, userAta);

    const ticketPda = getTicketPDA(draw.pda, userKp.publicKey, 0);
    await (program.methods
      .buyTicketWithReferral(Buffer.from([1, 2, 3, 4, 5, 6, 7]), Buffer.from([7]))
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

    const referrerAfter = await getAccount(connection, referrerAta);
    const userAfter = await getAccount(connection, userAta);

    expect(referrerAfter.amount - referrerBefore.amount).to.equal(expectedReferral, "5% de 7×base");
    expect(userBefore.amount - userAfter.amount).to.equal(price, "usuário debitado no preço combinatório total (7×base)");
    expect(userBefore.amount - userAfter.amount - (referrerAfter.amount - referrerBefore.amount)).to.equal(
      expectedPrizeAmount,
      "95% de 7×base indo pro prize_vault"
    );
  });
});
