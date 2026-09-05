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
 * Valida a Sub-etapa 3C: settle_monthly_tickets. Nenhuma lógica de
 * finalize/pay mensal existe ainda.
 *
 *  1. Settle em lote de vários tickets (pares [ticket, claim] em
 *     remainingAccounts) — classifica corretamente os tiers, batendo com
 *     um cálculo independente feito aqui em TS (mesma fórmula de
 *     resolve_tier, D3: numbers_count do próprio ticket).
 *  2. monthly_winner_counts incrementado só para tiers <= 9.
 *  3. Dedup no reenvio: reenviar o MESMO lote falha a transação inteira
 *     (MonthlyTicketAlreadyClaimed) — comportamento DIFERENTE do diário
 *     (que pula silenciosamente), documentado no código.
 *  4. Rejeição de ticket cuja draw_id está fora do range coberto.
 *  5. Transição de status 1 -> 2 quando tickets_processed alcança
 *     tickets_target.
 *
 * Nota sobre draws "soltas": qualquer draw diária criada aqui que NÃO
 * entre em nenhum range mensal bem-sucedido quebra a contiguidade exigida
 * por open_monthly_draw para o PRÓXIMO arquivo de teste que tentar abrir
 * um mês. Por isso: (a) a draw de "descoberta" do seed é incluída no
 * próprio range mensal deste arquivo, e (b) a draw usada só para testar
 * "fora do range" (dOut) é fechada com um mensal-ponte de 1 draw só no
 * final, restaurando a contiguidade pros arquivos seguintes.
 */
describe("monthly_settle_tickets — Sub-etapa 3C (repontuação em lote)", () => {
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

  // Mesma fórmula de resolve_tier em scoring.rs — recalculada aqui de
  // forma independente pra conferir a classificação.
  function expectedTier(hits: number, cryptoHit: boolean, numbersCount: number): number {
    if (hits > numbersCount) return 255;
    const deficit = numbersCount - hits;
    if (deficit > 4) return 255;
    const base = deficit * 2;
    return cryptoHit ? base : base + 1;
  }

  function countHits(ticketNumbers: number[], resultNums: number[]): number {
    return ticketNumbers.filter((n) => resultNums.includes(n)).length;
  }

  // MonthlyClaim nunca é referenciada como Account<'info, MonthlyClaim> em
  // nenhuma struct de Accounts (settle_monthly_tickets.rs a cria à mão via
  // CPI + try_serialize, já que remaining_accounts não suporta a macro
  // #[account(init)]) — então o Anchor não a inclui no IDL e
  // `program.account.monthlyClaim` não existe. Decodificamos os bytes
  // manualmente aqui, o que também serve como conferência independente de
  // que o try_serialize gravou o layout certo. Isso deve se resolver
  // sozinho quando uma etapa futura (finalize/pay mensal) precisar ler
  // MonthlyClaim via Account<T> de verdade numa Accounts struct.
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
    let offset = 8; // discriminator
    const monthlyDraw = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const ticket = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const owner = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const tier = data.readUInt8(offset); offset += 1;
    const paid = data.readUInt8(offset) !== 0; offset += 1;
    const bump = data.readUInt8(offset);
    return { monthlyDraw, ticket, owner, tier, paid, bump };
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
  type TicketRef = { pda: PublicKey; owner: PublicKey; numbers: number[] };

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

  async function buyTicketWithNumbers(drawPda: PublicKey, numbers: number[]): Promise<TicketRef> {
    const { kp, ata } = await fundWallet(mint, ticketPrice.toNumber() * 2);
    const ticketPda = getTicketPDA(drawPda, kp.publicKey, 0);
    const userDrawState = getUserDrawStatePDA(drawPda, kp.publicKey);
    const userGlobalStateAcc = getUserGlobalStatePDA(kp.publicKey);

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

    return { pda: ticketPda, owner: kp.publicKey, numbers };
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

  function openMonthlyDrawIx(
    firstId: anchor.BN,
    lastId: anchor.BN,
    monthlyDrawPda: PublicKey,
    draws: PublicKey[]
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
        draws.map((pk) => ({ pubkey: pk, isWritable: false, isSigner: false }))
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

    console.log(`    [setup] mint=${mint.toBase58()} ticketPrice=${ticketPrice.toString()} numbersCount=${numbersCount}`);
  });

  let resultNumbers: number[];

  let dDisc: DrawRef;
  let discoveryTicket: TicketRef;
  let dA: DrawRef, dB: DrawRef, dOut: DrawRef;
  let winnerA1: TicketRef, winnerA2: TicketRef, loserA: TicketRef;
  let winnerB1: TicketRef, loserB: TicketRef;
  let monthlyDrawPda: PublicKey;
  let mResultCrypto: number;
  let allTickets: TicketRef[];
  let expectedTierByTicket: Map<string, number>;

  it("descobre o resultado determinístico do seed de teste (a draw de descoberta entra no range mensal, não fica solta)", async () => {
    dDisc = await openDrawOnly();
    discoveryTicket = await buyTicketWithNumbers(
      dDisc.pda,
      Array.from({ length: numbersCount }, (_, i) => i + 1)
    );
    const [numbers] = await closeDrawFor(dDisc);
    resultNumbers = numbers;
    console.log(`    [discovery] resultNumbers=${resultNumbers}`);
  });

  it("monta sorteios diários com vencedores em tiers diferentes + perdedores, abre e fecha o mensal (cobrindo dDisc..dB)", async () => {
    // draw A: 2 vencedores (6 e 5 acertos) + 1 perdedor (0 acertos)
    dA = await openDrawOnly();
    winnerA1 = await buyTicketWithNumbers(dA.pda, numbersWithHits(resultNumbers, numbersCount, numbersCount));
    winnerA2 = await buyTicketWithNumbers(dA.pda, numbersWithHits(resultNumbers, numbersCount - 1, numbersCount));
    loserA = await buyTicketWithNumbers(dA.pda, numbersWithHits(resultNumbers, 0, numbersCount));
    await closeDrawFor(dA);

    // draw B: 1 vencedor (4 acertos) + 1 perdedor
    dB = await openDrawOnly();
    winnerB1 = await buyTicketWithNumbers(dB.pda, numbersWithHits(resultNumbers, numbersCount - 2, numbersCount));
    loserB = await buyTicketWithNumbers(dB.pda, numbersWithHits(resultNumbers, 0, numbersCount));
    await closeDrawFor(dB);

    // draw fora do range mensal (usada só pro teste de rejeição por range;
    // fechada com um mensal-ponte de 1 draw só no final deste arquivo).
    dOut = await openDrawOnly();
    await buyTicketWithNumbers(dOut.pda, numbersWithHits(resultNumbers, numbersCount, numbersCount));
    await closeDrawFor(dOut);

    // Range mensal = [dDisc, dB] — inclui a draw de descoberta de
    // propósito, pra não deixar nenhuma draw solta quebrando a
    // contiguidade exigida por open_monthly_draw.
    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const lastCovered = Number(msBefore.lastCoveredDrawId);
    const firstDrawId = lastCovered > 0 ? new anchor.BN(lastCovered + 1) : dDisc.id;
    expect(firstDrawId.toNumber()).to.equal(dDisc.id.toNumber(), "pré-condição: dDisc precisa ser contíguo com o último mês fechado");

    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    monthlyDrawPda = getMonthlyDrawPDA(nextMonthlyId);

    await openMonthlyDrawIx(dDisc.id, dB.id, monthlyDrawPda, [dDisc.pda, dA.pda, dB.pda]).rpc();

    const monthlyDrawBefore: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(monthlyDrawBefore.ticketsTarget)).to.equal(6); // 1 (dDisc) + 3 (dA) + 2 (dB)

    // Fecha o VRF do mensal (mesmo seed determinístico de teste).
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

    const monthlyDrawAfter: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(monthlyDrawAfter.status)).to.equal(1);

    const mResultNumbers = Array.from(monthlyDrawAfter.resultNumbers as Iterable<number>, (n: any) => Number(n));
    mResultCrypto = Number(monthlyDrawAfter.resultCrypto);
    expect(mResultNumbers).to.deep.equal(resultNumbers, "mensal deveria sortear o mesmo resultado do diário");

    // Calcula o tier esperado de CADA ticket (inclusive o de descoberta,
    // que joga com números "cegos" — não sabíamos o resultado quando
    // compramos) de forma genérica e independente, pra conferir depois.
    const cryptoHit = 1 === mResultCrypto; // todos os tickets compraram crypto=1
    allTickets = [discoveryTicket, winnerA1, winnerA2, loserA, winnerB1, loserB];
    expectedTierByTicket = new Map();
    for (const t of allTickets) {
      const hits = countHits(t.numbers, resultNumbers);
      expectedTierByTicket.set(t.pda.toBase58(), expectedTier(hits, cryptoHit, numbersCount));
    }

    const designedWinnerTiers = [
      expectedTierByTicket.get(winnerA1.pda.toBase58())!,
      expectedTierByTicket.get(winnerA2.pda.toBase58())!,
      expectedTierByTicket.get(winnerB1.pda.toBase58())!,
    ];
    expect(new Set(designedWinnerTiers).size).to.equal(3, "os 3 vencedores desenhados deveriam cair em tiers distintos");
    for (const t of designedWinnerTiers) {
      expect(t).to.be.lte(9);
    }
  });

  it("rejeita ticket cuja draw_id está fora do range coberto pelo mensal", async () => {
    const outTickets = await program.account.ticket.all([
      { memcmp: { offset: 8 + 32, bytes: dOut.pda.toBase58() } },
    ]);
    expect(outTickets.length).to.be.greaterThan(0);
    const realOutTicket = outTickets[0].publicKey;

    const claimPda = getMonthlyClaimPDA(monthlyDrawPda, realOutTicket);

    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .settleMonthlyTickets(1)
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyDraw: monthlyDrawPda,
          systemProgram: SystemProgram.programId,
        }).remainingAccounts([
          { pubkey: realOutTicket, isWritable: false, isSigner: false },
          { pubkey: claimPda, isWritable: true, isSigner: false },
        ]).rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "ticket fora do range deveria ser rejeitado");
    expect(errText).to.match(/InvalidTicket/);

    const claimInfo = await connection.getAccountInfo(claimPda);
    expect(claimInfo).to.equal(null, "nenhuma MonthlyClaim deveria ter sido criada");
  });

  function claimAccountsFor(tickets: TicketRef[]) {
    return tickets.flatMap((t) => {
      const claimPda = getMonthlyClaimPDA(monthlyDrawPda, t.pda);
      return [
        { pubkey: t.pda, isWritable: false, isSigner: false },
        { pubkey: claimPda, isWritable: true, isSigner: false },
      ];
    });
  }

  async function assertClaimsMatch(tickets: TicketRef[]) {
    for (const t of tickets) {
      const claim = await fetchMonthlyClaim(getMonthlyClaimPDA(monthlyDrawPda, t.pda));
      const expected = expectedTierByTicket.get(t.pda.toBase58())!;

      expect(claim.tier).to.equal(expected, `tier do ticket ${t.pda.toBase58()}`);
      expect(claim.owner.toBase58()).to.equal(t.owner.toBase58());
      expect(claim.paid).to.equal(false);
      expect(claim.monthlyDraw.toBase58()).to.equal(monthlyDrawPda.toBase58());
      expect(claim.ticket.toBase58()).to.equal(t.pda.toBase58());
    }
  }

  // Processamos em 2 lotes de propósito: [primeiros4] depois [últimos2].
  // Isso permite testar o hard-fail de duplicata ENQUANTO o settlement
  // ainda está em andamento (tickets_processed < tickets_target) — um
  // reenvio depois que TUDO já terminou (100% completo) cai no guard de
  // "já completo" ANTES de chegar no loop que faria o hard-fail, e vira
  // um no-op seguro (ver o teste dedicado a isso mais abaixo). Os dois
  // comportamentos são intencionais e diferentes; por isso separamos.
  let firstBatch: TicketRef[];
  let secondBatch: TicketRef[];

  it("settle_monthly_tickets (lote 1/2): processa os 4 primeiros tickets, classifica os tiers certo", async () => {
    firstBatch = [discoveryTicket, winnerA1, winnerA2, loserA];
    secondBatch = [winnerB1, loserB];

    await (program.methods
      .settleMonthlyTickets(firstBatch.length)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyDraw: monthlyDrawPda,
        systemProgram: SystemProgram.programId,
      }).remainingAccounts(claimAccountsFor(firstBatch))
        .preInstructions([CU_LIMIT_IX])
        .rpc();

    const monthlyDraw: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(monthlyDraw.ticketsProcessed)).to.equal(firstBatch.length);
    expect(Number(monthlyDraw.status)).to.equal(1, "ainda não completou (faltam 2 tickets) — status continua 1");

    await assertClaimsMatch(firstBatch);
  });

  it("reenviar o LOTE 1 no meio do processamento falha a transação inteira (hard-fail de duplicata, diferente do skip silencioso do diário)", async () => {
    const drawBefore: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);

    let threw = false;
    let errText = "";
    try {
      await (program.methods
        .settleMonthlyTickets(firstBatch.length)
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyDraw: monthlyDrawPda,
          systemProgram: SystemProgram.programId,
        }).remainingAccounts(claimAccountsFor(firstBatch))
          .preInstructions([CU_LIMIT_IX])
          .rpc();
    } catch (e: any) {
      threw = true;
      errText = e?.message || String(e);
    }

    expect(threw).to.equal(true, "reenviar tickets já reivindicados ANTES do settlement completar deveria falhar");
    expect(errText).to.match(/MonthlyTicketAlreadyClaimed/);

    // A transação inteira reverteu — nada mudou, diferente do
    // comportamento skip-silencioso do diário.
    const drawAfter: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(drawAfter.ticketsProcessed)).to.equal(Number(drawBefore.ticketsProcessed));
  });

  it("settle_monthly_tickets (lote 2/2): processa os 2 tickets restantes, status 1 -> 2, winner_counts bate", async () => {
    await (program.methods
      .settleMonthlyTickets(secondBatch.length)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyDraw: monthlyDrawPda,
        systemProgram: SystemProgram.programId,
      }).remainingAccounts(claimAccountsFor(secondBatch))
        .preInstructions([CU_LIMIT_IX])
        .rpc();

    const monthlyDraw: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(monthlyDraw.ticketsProcessed)).to.equal(allTickets.length);
    expect(Number(monthlyDraw.status)).to.equal(2, "status deveria virar 2 quando tickets_processed alcança tickets_target");

    await assertClaimsMatch(secondBatch);
    await assertClaimsMatch(firstBatch); // confirma que o lote 1 continua intacto

    const expectedWinnerCounts = new Array(10).fill(0);
    for (const t of allTickets) {
      const expected = expectedTierByTicket.get(t.pda.toBase58())!;
      if (expected <= 9) expectedWinnerCounts[expected] += 1;
    }

    const winnerCounts = monthlyDraw.monthlyWinnerCounts.map((x: any) => Number(x));
    for (let tier = 0; tier <= 9; tier++) {
      expect(winnerCounts[tier]).to.equal(expectedWinnerCounts[tier], `winner_counts[${tier}]`);
    }
  });

  it("reenviar o lote inteiro DEPOIS de completo (status 2) é um no-op seguro, não dá erro", async () => {
    // Diferente do reenvio no meio do processamento: como
    // tickets_processed já alcançou tickets_target, o guard de "já
    // completo" no topo do handler retorna antes mesmo de chegar no loop
    // que faria o hard-fail — reenviar (mesmo passando as contas reais,
    // já reivindicadas) é seguro e não dá erro. Comportamento intencional,
    // mesma lição de idempotência do pay_winners_batch (Etapa 1).
    await (program.methods
      .settleMonthlyTickets(allTickets.length)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyDraw: monthlyDrawPda,
        systemProgram: SystemProgram.programId,
      }).remainingAccounts(claimAccountsFor(allTickets))
        .preInstructions([CU_LIMIT_IX])
        .rpc();

    const monthlyDraw: any = await program.account.monthlyDraw.fetch(monthlyDrawPda);
    expect(Number(monthlyDraw.status)).to.equal(2);
    expect(Number(monthlyDraw.ticketsProcessed)).to.equal(allTickets.length);
  });

  it("fecha o gap deixado por dOut com um mensal-ponte de 1 draw só, restaurando contiguidade pros próximos arquivos", async () => {
    const msBefore: any = await program.account.monthlyState.fetch(monthlyState);
    const nextMonthlyId = Number(msBefore.currentMonthlyId) + 1;
    const bridgePda = getMonthlyDrawPDA(nextMonthlyId);

    await openMonthlyDrawIx(dOut.id, dOut.id, bridgePda, [dOut.pda]).rpc();

    const msAfter: any = await program.account.monthlyState.fetch(monthlyState);
    expect(Number(msAfter.lastCoveredDrawId)).to.equal(dOut.id.toNumber());
  });
});
