import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
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
 * Valida a ETAPA 1 do pagamento em lote (pay_winners_batch via remaining_accounts):
 *
 *  1. Pagar 1 ticket no formato ANTIGO (contas nomeadas, sem remainingAccounts)
 *     ainda funciona e credita o valor certo.
 *  2. Pagar vários tickets NUM LOTE SÓ (remainingAccounts, pares [ticket, ata])
 *     credita cada ganhador com o valor certo do seu tier.
 *  3. Reenviar o mesmo lote é idempotente: não paga em dobro, não dá erro.
 *  4. draw.tickets_paid soma corretamente e o status vira 4 quando todos
 *     os vencedores foram pagos.
 *
 * Este teste é independente de tests/megabyt.ts: reaproveita o global_state
 * se ele já existir (quando roda junto na mesma validator via `anchor test`),
 * ou inicializa o protocolo do zero se rodar sozinho.
 */
describe("pay_winners_batch — pagamento em lote via remaining_accounts", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  // Mesma regra de MIN_PRIZE_PER_WINNER de finalize_payouts.rs (1 USDT, 6 decimais)
  const MIN_PRIZE_PER_WINNER = 1_000_000;

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

  /**
   * Monta um conjunto de `count` números únicos (1..72) com exatamente
   * `hits` deles vindos de `result` — usado pra construir tickets com tier
   * alvo conhecido sem precisar reimplementar a geração de números on-chain
   * (Keccak + rejection sampling) em TypeScript.
   */
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
      if (candidate > 200) {
        throw new Error("numbersWithHits: não foi possível completar o conjunto de números");
      }
    }
    return picks;
  }

  async function fundWallet(
    mint: PublicKey,
    tokenAmount: number
  ): Promise<{ kp: Keypair; ata: PublicKey }> {
    const kp = Keypair.generate();
    const sig = await connection.requestAirdrop(kp.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    const ata = await createAccount(connection, admin, mint, kp.publicKey);
    await mintTo(connection, admin, mint, ata, admin, tokenAmount);
    return { kp, ata };
  }

  let mint: PublicKey;
  let ticketPrice: anchor.BN;
  let numbersCount: number;

  let discoveryDrawPda: PublicKey;
  let resultNumbers: number[];
  let resultCrypto: number;

  let testDrawPda: PublicKey;
  let fillerCount: number;

  type Winner = { kp: Keypair; ata: PublicKey; ticket: PublicKey; hits: number };
  const winners: Winner[] = [];
  let fillerKp: Keypair;
  let fillerAta: PublicKey;
  const fillerTickets: PublicKey[] = [];

  const expectedPrize: bigint[] = []; // na mesma ordem de `winners`

  before(async () => {
    const adminAirdrop = await connection.requestAirdrop(
      admin.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(adminAirdrop, "confirmed");

    let globalAccount: any = null;
    try {
      globalAccount = await program.account.globalState.fetch(globalState);
    } catch (_e) {
      globalAccount = null;
    }

    if (!globalAccount) {
      // Ambiente limpo (nenhum outro arquivo de teste rodou antes): inicializa
      // do zero com um ticket_price generoso, pra não precisar de dezenas de
      // tickets de enchimento só pra passar da regra anti-esmola ($1 mínimo).
      const usdtMint = await createMint(connection, admin, admin.publicKey, null, 6);
      const bytiMint = await createMint(connection, admin, admin.publicKey, null, 6);
      ticketPrice = new anchor.BN(50_000_000); // 50 USDT (6 decimais)

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
      // Reaproveita o global_state/vaults já inicializados por outro arquivo
      // de teste (ex: tests/megabyt.ts) na mesma validator.
      mint = globalAccount.tokenMint;
      ticketPrice = globalAccount.ticketPrice;
    }

    numbersCount = Number(globalAccount.numbersCount);
    expect(numbersCount).to.be.gte(
      5,
      "este teste assume numbersCount >= 5 (deficit > 4 garante tier 255 pro ticket de enchimento)"
    );

    console.log(
      `    [setup] mint=${mint.toBase58()} ticketPrice=${ticketPrice.toString()} numbersCount=${numbersCount}`
    );
  });

  it("descobre o resultado determinístico do VRF em modo teste", async () => {
    // programs/.../close_draw.rs cai num fallback determinístico (feature
    // "testing", que é a default em Cargo.toml) sempre que a conta de
    // randomness não parseia como Switchboard real — exatamente o caso
    // aqui, já que randomnessAccountData nunca é criada on-chain. Esse
    // fallback é fixo (mesmo seed sempre, independente da draw), então
    // rodamos um sorteio descartável só pra descobrir esses números antes
    // de comprar os tickets do sorteio real — não dá pra saber o resultado
    // de uma draw ANTES de comprar e fechar ela.
    const globalBefore: any = await program.account.globalState.fetch(globalState);
    const nextId = new anchor.BN(globalBefore.currentDrawId || 0).add(new anchor.BN(1));
    discoveryDrawPda = getDrawPDA(nextId);

    await (program.methods
      .openDraw(new anchor.BN(3600))
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        drawState: discoveryDrawPda,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const { kp: dummyUser, ata: dummyAta } = await fundWallet(mint, ticketPrice.toNumber());
    const dummyTicket = getTicketPDA(discoveryDrawPda, dummyUser.publicKey, 0);
    const dummyUserDrawState = getUserDrawStatePDA(discoveryDrawPda, dummyUser.publicKey);
    const dummyUserGlobalState = getUserGlobalStatePDA(dummyUser.publicKey);
    const dummyNumbers = Array.from({ length: numbersCount }, (_, i) => i + 1);

    await (program.methods
      .buyTicket(Buffer.from(dummyNumbers), 1)
      .accounts as any)({
        user: dummyUser.publicKey,
        globalState,
        drawState: discoveryDrawPda,
        userDrawState: dummyUserDrawState,
        userGlobalState: dummyUserGlobalState,
        ticket: dummyTicket,
        userTokenAccount: dummyAta,
        prizeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([dummyUser]).rpc();

    const randomnessKp = Keypair.generate();

    await (program.methods
      .requestRandomness()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: discoveryDrawPda,
        randomnessAccount: randomnessKp.publicKey,
      }).rpc();

    await (program.methods
      .closeDraw()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: discoveryDrawPda,
        randomnessAccountData: randomnessKp.publicKey,
      }).preInstructions([CU_LIMIT_IX]).rpc();

    const discoveryDraw: any = await program.account.draw.fetch(discoveryDrawPda);
    // draw.result_numbers e um Vec<u8> on-chain; o cliente Anchor desserializa
    // como Buffer/Uint8Array, nao Array puro — .map() num typed array devolve
    // outro typed array (sem .push), entao convertemos explicitamente.
    resultNumbers = Array.from(discoveryDraw.resultNumbers as Iterable<number>, (n) => Number(n));
    resultCrypto = Number(discoveryDraw.resultCrypto);

    expect(resultNumbers.length).to.equal(numbersCount);
    expect(new Set(resultNumbers).size).to.equal(numbersCount);
    console.log(`    [discovery] resultNumbers=${resultNumbers} resultCrypto=${resultCrypto}`);
  });

  it("monta um sorteio com 1 perdedor (enchimento) + 3 vencedores em tiers diferentes", async () => {
    const globalBefore: any = await program.account.globalState.fetch(globalState);
    const nextId = new anchor.BN(globalBefore.currentDrawId || 0).add(new anchor.BN(1));
    testDrawPda = getDrawPDA(nextId);

    await (program.methods
      .openDraw(new anchor.BN(3600))
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        drawState: testDrawPda,
        systemProgram: SystemProgram.programId,
      }).rpc();

    // Enchimento: número de tickets perdedores suficiente pra que os prêmios
    // dos 3 tiers vencedores fiquem acima do mínimo anti-esmola (1 USDT),
    // considerando o pior caso de bps efetivo depois da cascata (900 bps —
    // ver TIER_BPS em close_draw.rs).
    const WORST_BPS = 900;
    const SAFETY = 1.5;
    const priceNum = ticketPrice.toNumber();
    const neededTotalTickets = Math.ceil(
      (MIN_PRIZE_PER_WINNER * SAFETY * 10000) / (0.6 * priceNum * WORST_BPS)
    );
    fillerCount = Math.min(60, Math.max(10, neededTotalTickets - 3));
    console.log(`    [setup] fillerCount=${fillerCount} (neededTotalTickets~=${neededTotalTickets})`);

    // 3 vencedores: 6, 5 e 4 acertos (deficits 0, 1, 2) — tiers garantidamente
    // distintos entre si (a fórmula do tier só depende do deficit e do
    // acerto de crypto, que é igual pros três porque todos compram crypto=1).
    const hitsPlan = [numbersCount, numbersCount - 1, numbersCount - 2];

    for (const hits of hitsPlan) {
      const { kp, ata } = await fundWallet(mint, priceNum * 2);
      const numbers = numbersWithHits(resultNumbers, hits, numbersCount);
      const ticketPda = getTicketPDA(testDrawPda, kp.publicKey, 0);
      const userDrawState = getUserDrawStatePDA(testDrawPda, kp.publicKey);
      const userGlobalStateAcc = getUserGlobalStatePDA(kp.publicKey);

      await (program.methods
        .buyTicket(Buffer.from(numbers), 1)
        .accounts as any)({
          user: kp.publicKey,
          globalState,
          drawState: testDrawPda,
          userDrawState,
          userGlobalState: userGlobalStateAcc,
          ticket: ticketPda,
          userTokenAccount: ata,
          prizeVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([kp]).rpc();

      winners.push({ kp, ata, ticket: ticketPda, hits });
    }

    // Enchimento: 1 carteira compra `fillerCount` tickets com 0 acertos
    // (deficit = numbersCount > 4 => tier 255, garantidamente perdedor).
    const fillerNumbers = numbersWithHits(resultNumbers, 0, numbersCount);
    const funded = await fundWallet(mint, priceNum * (fillerCount + 1));
    fillerKp = funded.kp;
    fillerAta = funded.ata;

    const fillerUserDrawState = getUserDrawStatePDA(testDrawPda, fillerKp.publicKey);
    const fillerUserGlobalState = getUserGlobalStatePDA(fillerKp.publicKey);

    for (let i = 0; i < fillerCount; i++) {
      const ticketPda = getTicketPDA(testDrawPda, fillerKp.publicKey, i);

      await (program.methods
        .buyTicket(Buffer.from(fillerNumbers), 1)
        .accounts as any)({
          user: fillerKp.publicKey,
          globalState,
          drawState: testDrawPda,
          userDrawState: fillerUserDrawState,
          userGlobalState: fillerUserGlobalState,
          ticket: ticketPda,
          userTokenAccount: fillerAta,
          prizeVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([fillerKp]).rpc();

      fillerTickets.push(ticketPda);
    }

    const drawAccount: any = await program.account.draw.fetch(testDrawPda);
    expect(Number(drawAccount.ticketsSold)).to.equal(winners.length + fillerCount);
  });

  it("fecha o sorteio de teste e confirma o mesmo resultado determinístico", async () => {
    const randomnessKp = Keypair.generate();

    await (program.methods
      .requestRandomness()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: testDrawPda,
        randomnessAccount: randomnessKp.publicKey,
      }).rpc();

    await (program.methods
      .closeDraw()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: testDrawPda,
        randomnessAccountData: randomnessKp.publicKey,
      }).preInstructions([CU_LIMIT_IX]).rpc();

    const drawAccount: any = await program.account.draw.fetch(testDrawPda);
    const gotNumbers = Array.from(drawAccount.resultNumbers as Iterable<number>, (n) => Number(n));
    const gotCrypto = Number(drawAccount.resultCrypto);

    // Confirma a premissa do teste (o seed de teste é fixo/determinístico,
    // independente da draw). Se isso falhar, os tickets foram construídos
    // pro resultado ERRADO e o resto do teste não tem validade — melhor
    // falhar aqui com uma mensagem clara do que dar falso positivo/negativo
    // mais adiante.
    expect(gotNumbers).to.deep.equal(
      resultNumbers,
      "resultado do sorteio de teste divergiu do sorteio de descoberta — " +
      "o seed determinístico de teste não é estável neste ambiente"
    );
    expect(gotCrypto).to.equal(resultCrypto);
  });

  it("settle_tickets: classifica todos os tickets em lotes", async () => {
    const allTickets = [...winners.map((w) => w.ticket), ...fillerTickets];
    const BATCH = 20;

    for (let offset = 0; offset < allTickets.length; offset += BATCH) {
      const chunk = allTickets.slice(offset, offset + BATCH);
      const remainingAccounts = chunk.map((pk) => ({
        pubkey: pk,
        isWritable: true,
        isSigner: false,
      }));

      await (program.methods
        .settleTickets(chunk.length)
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          draw: testDrawPda,
        }).remainingAccounts(remainingAccounts)
          .preInstructions([CU_LIMIT_IX])
          .rpc();
    }

    const drawAccount: any = await program.account.draw.fetch(testDrawPda);
    expect(drawAccount.settlementComplete).to.equal(true);
    expect(Number(drawAccount.ticketsProcessed)).to.equal(allTickets.length);

    // Pré-condições pro resto do teste: os 3 vencedores caíram em tiers
    // distintos, e o de enchimento ficou sem prêmio (255).
    const tiers = new Set<number>();
    for (const w of winners) {
      const t: any = await program.account.ticket.fetch(w.ticket);
      const tier = Number(t.tier);
      expect(tier).to.be.lte(9, `ticket com ${w.hits} acertos deveria ser vencedor (tier <= 9)`);
      tiers.add(tier);
    }
    expect(tiers.size).to.equal(winners.length, "os 3 vencedores deveriam ter caído em tiers distintos");

    const fillerSample: any = await program.account.ticket.fetch(fillerTickets[0]);
    expect(Number(fillerSample.tier)).to.equal(255);
  });

  it("finalize_payouts: calcula o prêmio por tier", async () => {
    await (program.methods
      .finalizePayouts()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: testDrawPda,
      }).rpc();

    const drawAccount: any = await program.account.draw.fetch(testDrawPda);
    expect(Number(drawAccount.status)).to.equal(3);

    for (const w of winners) {
      const t: any = await program.account.ticket.fetch(w.ticket);
      const tier = Number(t.tier);
      const prize = BigInt(drawAccount.prizePerTier[tier].toString());
      expectedPrize.push(prize);
      console.log(`    [finalize] winner hits=${w.hits} tier=${tier} prize=${prize}`);
    }

    // A regra anti-esmola só zera prêmios abaixo de $1 — com o enchimento
    // calculado no passo anterior, os 3 tiers vencedores devem ficar acima disso.
    for (const p of expectedPrize) {
      expect(p >= BigInt(MIN_PRIZE_PER_WINNER)).to.equal(
        true,
        "prêmio do tier abaixo do mínimo anti-esmola — aumentar fillerCount/SAFETY"
      );
    }
  });

  it("paga o vencedor 0 no formato ANTIGO (contas nomeadas, sem remainingAccounts)", async () => {
    const w = winners[0];
    const before = await getAccount(connection, w.ata);

    await (program.methods
      .payWinnersBatch(1)
      .accounts as any)({
        draw: testDrawPda,
        ticket: w.ticket,
        globalState,
        prizeVault,
        userTokenAccount: w.ata,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const after = await getAccount(connection, w.ata);
    expect(after.amount - before.amount).to.equal(expectedPrize[0]);

    const ticketAccount: any = await program.account.ticket.fetch(w.ticket);
    expect(ticketAccount.paid).to.equal(true);

    const drawAccount: any = await program.account.draw.fetch(testDrawPda);
    expect(Number(drawAccount.ticketsPaid)).to.equal(1);
    expect(Number(drawAccount.status)).to.equal(3); // ainda faltam 2 vencedores
  });

  it("paga os vencedores 1 e 2 NUMA ÚNICA transação via remainingAccounts", async () => {
    const w1 = winners[1];
    const w2 = winners[2];

    const before1 = await getAccount(connection, w1.ata);
    const before2 = await getAccount(connection, w2.ata);

    await (program.methods
      .payWinnersBatch(2)
      .accounts as any)({
        draw: testDrawPda,
        ticket: w1.ticket,
        globalState,
        prizeVault,
        userTokenAccount: w1.ata,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).remainingAccounts([
        { pubkey: w2.ticket, isWritable: true, isSigner: false },
        { pubkey: w2.ata, isWritable: true, isSigner: false },
      ]).rpc();

    const after1 = await getAccount(connection, w1.ata);
    const after2 = await getAccount(connection, w2.ata);

    expect(after1.amount - before1.amount).to.equal(expectedPrize[1]);
    expect(after2.amount - before2.amount).to.equal(expectedPrize[2]);

    const t1: any = await program.account.ticket.fetch(w1.ticket);
    const t2: any = await program.account.ticket.fetch(w2.ticket);
    expect(t1.paid).to.equal(true);
    expect(t2.paid).to.equal(true);

    const drawAccount: any = await program.account.draw.fetch(testDrawPda);
    expect(Number(drawAccount.ticketsPaid)).to.equal(3);
    expect(Number(drawAccount.status)).to.equal(4);
    expect(drawAccount.isPaid).to.equal(true);
  });

  it("idempotência: reenviar o mesmo lote não paga em dobro nem dá erro", async () => {
    const w1 = winners[1];
    const w2 = winners[2];

    const before1 = await getAccount(connection, w1.ata);
    const before2 = await getAccount(connection, w2.ata);
    const drawBefore: any = await program.account.draw.fetch(testDrawPda);

    // Mesmo lote de novo — os dois tickets já estão pagos.
    await (program.methods
      .payWinnersBatch(2)
      .accounts as any)({
        draw: testDrawPda,
        ticket: w1.ticket,
        globalState,
        prizeVault,
        userTokenAccount: w1.ata,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).remainingAccounts([
        { pubkey: w2.ticket, isWritable: true, isSigner: false },
        { pubkey: w2.ata, isWritable: true, isSigner: false },
      ]).rpc();

    const after1 = await getAccount(connection, w1.ata);
    const after2 = await getAccount(connection, w2.ata);
    const drawAfter: any = await program.account.draw.fetch(testDrawPda);

    expect(after1.amount).to.equal(before1.amount, "reenvio do lote NÃO deveria transferir de novo (winner 1)");
    expect(after2.amount).to.equal(before2.amount, "reenvio do lote NÃO deveria transferir de novo (winner 2)");
    expect(Number(drawAfter.ticketsPaid)).to.equal(Number(drawBefore.ticketsPaid));
    expect(Number(drawAfter.status)).to.equal(4);
  });
});
