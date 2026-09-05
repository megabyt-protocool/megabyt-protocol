import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  SystemProgram,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

/**
 * Valida a mudança de regra de crypto/fases:
 *
 *  1. crypto_count nasce em 10 desde o initialize (ALL_CRYPTOS_COUNT).
 *  2. Comprar ticket com qualquer crypto de 1 a 10 funciona na fase 1
 *     (antes só crypto=1 era válido).
 *  3. Comprar com crypto 11 falha (fora do range).
 *  4/5/6. set_crypto_count muda o valor corretamente, rejeita valor fora
 *     de 1..10, e rejeita chamador que não é admin.
 *  7. advance_phase continua mudando numbers_count/supply normalmente,
 *     mas NÃO mexe mais em crypto_count (mesmo atravessando 2 fases reais,
 *     com o threshold de active_users de verdade).
 *
 * Nomeado pra ordenar DEPOIS de tests/megabyt.ts (que não é defensivo
 * quanto a estado compartilhado) — mesma lição da Sub-etapa 3B/3C.
 */
describe("crypto_count e sistema de fases", () => {
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

  // ---- Financiamento em massa (só pro teste de advance_phase com 500
  // carteiras) — evita `requestAirdrop` (faucet) por carteira, que sob
  // concorrência alta se mostrou o gargalo real ("Blockhash not found").
  // Transferência direta da admin (que já tem SOL) e ATA+mint combinados
  // numa unica tx — nenhum dos dois precisa da assinatura da carteira nova.

  async function fundManyWithSol(wallets: Keypair[], lamportsEach: number): Promise<void> {
    const CHUNK = 10;
    for (let i = 0; i < wallets.length; i += CHUNK) {
      const chunk = wallets.slice(i, i + CHUNK);
      const tx = new Transaction();
      for (const w of chunk) {
        tx.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: w.publicKey, lamports: lamportsEach }));
      }
      await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
    }
  }

  async function createAtaAndMintMany(
    wallets: Keypair[],
    mintPk: PublicKey,
    tokenAmount: number
  ): Promise<Map<string, PublicKey>> {
    const atas = new Map<string, PublicKey>();
    const CHUNK = 5; // 2 instrucoes por carteira (create + mintTo)
    for (let i = 0; i < wallets.length; i += CHUNK) {
      const chunk = wallets.slice(i, i + CHUNK);
      const tx = new Transaction();
      for (const w of chunk) {
        const ata = getAssociatedTokenAddressSync(mintPk, w.publicKey, false, TOKEN_PROGRAM_ID);
        atas.set(w.publicKey.toBase58(), ata);
        tx.add(createAssociatedTokenAccountInstruction(admin.publicKey, ata, w.publicKey, mintPk, TOKEN_PROGRAM_ID));
        tx.add(createMintToInstruction(mintPk, ata, admin.publicKey, tokenAmount, [], TOKEN_PROGRAM_ID));
      }
      await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
    }
    return atas;
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
      }).signers([kp]).rpc();

    return { kp, ticketPda };
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

    console.log(`    [setup] mint=${mint.toBase58()} ticketPrice=${ticketPrice.toString()} numbersCount=${numbersCount} cryptoCount=${globalAccount.cryptoCount}`);
  });

  it("crypto_count nasce em 10 desde o initialize (ALL_CRYPTOS_COUNT)", async () => {
    const gs: any = await program.account.globalState.fetch(globalState);
    expect(gs.cryptoCount).to.equal(10);
  });

  it("compra com qualquer crypto de 1 a 10 funciona na fase 1", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    for (let crypto = 1; crypto <= 10; crypto++) {
      const { ticketPda } = await buyTicket(draw.pda, numbers, crypto);
      const ticket: any = await program.account.ticket.fetch(ticketPda);
      expect(Number(ticket.crypto)).to.equal(crypto);
      expect(Number(ticket.cryptoNumber)).to.equal(crypto);
    }

    const drawAccount: any = await program.account.draw.fetch(draw.pda);
    expect(Number(drawAccount.ticketsSold)).to.equal(10);
  });

  it("compra com crypto 11 falha (fora do range 1..10)", async () => {
    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    let threw = false;
    let errText = "";
    try {
      await buyTicket(draw.pda, numbers, 11);
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "crypto 11 deveria ser rejeitado");
    expect(errText).to.match(/InvalidCryptoNumber/);
  });

  it("set_crypto_count muda o valor corretamente", async () => {
    await (program.methods
      .setCryptoCount(3)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();

    let gs: any = await program.account.globalState.fetch(globalState);
    expect(gs.cryptoCount).to.equal(3);

    // Restaura pra 10 (canônico) antes dos próximos testes.
    await (program.methods
      .setCryptoCount(10)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();

    gs = await program.account.globalState.fetch(globalState);
    expect(gs.cryptoCount).to.equal(10);
  });

  it("set_crypto_count rejeita valor fora de 1..10", async () => {
    for (const bad of [0, 11]) {
      let threw = false;
      let errText = "";
      try {
        await (program.methods
          .setCryptoCount(bad)
          .accounts as any)({
            admin: admin.publicKey,
            globalState,
          }).rpc();
      } catch (e: any) {
        threw = true;
        errText = e?.message || String(e);
      }
      expect(threw).to.equal(true, `crypto_count=${bad} deveria ser rejeitado`);
      expect(errText).to.match(/InvalidCryptoNumber/);
    }

    const gs: any = await program.account.globalState.fetch(globalState);
    expect(gs.cryptoCount).to.equal(10, "valor invalido nao deveria ter sido gravado");
  });

  it("set_crypto_count rejeita chamador que não é admin", async () => {
    const fakeAdmin = Keypair.generate();
    const sig = await connection.requestAirdrop(fakeAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .setCryptoCount(5)
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
    expect(gs.cryptoCount).to.equal(10, "nao deveria ter mudado");
  });

  it("advance_phase muda numbers_count/supply mas NÃO mexe em crypto_count (2 fases reais, com threshold de active_users de verdade)", async function () {
    this.timeout(480_000);

    // ---- Fase 1 -> 2 (Genesis, threshold=0 — nao precisa de carteira nenhuma) ----
    const gsBefore: any = await program.account.globalState.fetch(globalState);
    expect(Number(gsBefore.currentPhase)).to.equal(0);
    const cryptoCountBefore = gsBefore.cryptoCount;

    await (program.methods
      .advancePhase()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();

    let gs: any = await program.account.globalState.fetch(globalState);
    expect(Number(gs.currentPhase)).to.equal(1);
    expect(gs.numbersCount).to.equal(6); // PHASE_CONFIG[0] (Genesis).numbers_per_ticket
    expect(Number(gs.currentPhaseSupply)).to.equal(10_000); // PHASE_CONFIG[0].supply_to_release
    expect(Number(gs.totalSupplyCap)).to.equal(10_000); // PHASE_CONFIG[0].cumulative_supply
    expect(gs.cryptoCount).to.equal(cryptoCountBefore, "crypto_count nao deveria mudar");

    // ---- Fase 2 -> 3 (Spark, threshold=500 active_users — de verdade) ----
    const needed = Math.max(0, 500 - Number(gs.activeUsers)) + 2; // pequena margem
    console.log(`    [advance_phase] faltam ${needed} carteiras novas pra bater o threshold de 500`);

    const draw = await openDrawOnly();
    const numbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    // Financiamento em massa (ver helpers acima): transferência direta da
    // admin em lote + ATA/mint combinados, em vez de requestAirdrop por
    // carteira (que sob 470 carteiras concorrentes se mostrou o gargalo
    // real — "Blockhash not found" vindo do faucet local sobrecarregado).
    const wallets = Array.from({ length: needed }, () => Keypair.generate());
    await fundManyWithSol(wallets, 0.02 * anchor.web3.LAMPORTS_PER_SOL);
    const atas = await createAtaAndMintMany(wallets, mint, ticketPrice.toNumber() * 2);

    async function buyWithWallet(kp: Keypair, retries = 3): Promise<void> {
      const ata = atas.get(kp.publicKey.toBase58())!;
      const ticketPda = getTicketPDA(draw.pda, kp.publicKey, 0);
      const userDrawState = getUserDrawStatePDA(draw.pda, kp.publicKey);
      const userGlobalStateAcc = getUserGlobalStatePDA(kp.publicKey);

      for (let attempt = 1; ; attempt++) {
        try {
          await (program.methods
            .buyTicket(Buffer.from(numbers), 1)
            .accounts as any)({
              user: kp.publicKey,
              globalState,
              drawState: draw.pda,
              userDrawState,
              userGlobalState: userGlobalStateAcc,
              ticket: ticketPda,
              userTokenAccount: ata,
              prizeVault,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            }).signers([kp]).rpc();
          return;
        } catch (e: any) {
          if (attempt > retries) throw e;
          await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
    }

    const BATCH = 10;
    for (let i = 0; i < wallets.length; i += BATCH) {
      const chunk = wallets.slice(i, i + BATCH);
      await Promise.all(chunk.map((kp) => buyWithWallet(kp)));
    }

    gs = await program.account.globalState.fetch(globalState);
    expect(Number(gs.activeUsers)).to.be.gte(500);

    await (program.methods
      .advancePhase()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
      }).rpc();

    gs = await program.account.globalState.fetch(globalState);
    expect(Number(gs.currentPhase)).to.equal(2);
    expect(gs.numbersCount).to.equal(6); // PHASE_CONFIG[1] (Spark).numbers_per_ticket (ainda 6)
    expect(Number(gs.currentPhaseSupply)).to.equal(90_000); // PHASE_CONFIG[1].supply_to_release
    expect(Number(gs.totalSupplyCap)).to.equal(100_000); // PHASE_CONFIG[1].cumulative_supply
    expect(gs.cryptoCount).to.equal(cryptoCountBefore, "crypto_count nao deveria mudar nem na segunda fase");
  });
});
