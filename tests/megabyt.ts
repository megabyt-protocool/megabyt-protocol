import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { SystemProgram, Keypair, PublicKey } from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

describe("megabyt", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Megabyt as Program<Megabyt>;
  const connection = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const user = Keypair.generate();

  let bytiMint: PublicKey;
  let usdtMint: PublicKey;
  let userTokenAccount: PublicKey;
  let drawStatePda: PublicKey;
  let ticket: PublicKey;
  let randomnessAccountData: Keypair;

  // All seeds v3
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

  before(async () => {
    const adminAirdropSig = await connection.requestAirdrop(
      admin.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(adminAirdropSig, "confirmed");

    const userAirdropSig = await connection.requestAirdrop(
      user.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(userAirdropSig, "confirmed");

    bytiMint = await createMint(connection, admin, admin.publicKey, null, 6);
    usdtMint = await createMint(connection, admin, admin.publicKey, null, 6);
    userTokenAccount = await createAccount(connection, admin, usdtMint, user.publicKey);
    await mintTo(connection, admin, usdtMint, userTokenAccount, admin, 1_000_000_000);

    randomnessAccountData = Keypair.generate();
  });

  it("initialize", async () => {
    await (program.methods
      .initialize(admin.publicKey, new anchor.BN(1_000_000), usdtMint, bytiMint)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const global = await program.account.globalState.fetch(globalState);
    expect(global.admin.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("initialize_vaults", async () => {
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
  });

  it("open_draw", async () => {
    const globalBefore: any = await program.account.globalState.fetch(globalState);
    const nextId = new anchor.BN(globalBefore.currentDrawId || 0).add(new anchor.BN(1));
    drawStatePda = getDrawPDA(nextId);

    await (program.methods
      .openDraw(new anchor.BN(3600))
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        drawState: drawStatePda,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const drawAccount = await program.account.draw.fetch(drawStatePda);
    expect(Number(drawAccount.status)).to.equal(0);
    expect(drawAccount.isOpen).to.equal(true);

    ticket = getTicketPDA(drawStatePda, user.publicKey, 0);
  });

  it("buy_ticket", async () => {
    const userDrawState = getUserDrawStatePDA(drawStatePda, user.publicKey);

    await (program.methods
      .buyTicket([1, 2, 3, 4, 5, 6], 1)
      .accounts as any)({
        user: user.publicKey,
        globalState,
        drawState: drawStatePda,
        userDrawState,
        ticket,
        userTokenAccount,
        prizeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();

    const ticketAccount = await program.account.ticket.fetch(ticket);
    expect(ticketAccount.owner.toBase58()).to.equal(user.publicKey.toBase58());
  });

  it("request_randomness", async () => {
    await (program.methods
      .requestRandomness()
      .accounts as any)({
        draw: drawStatePda,
        randomnessAccount: randomnessAccountData.publicKey,
      }).rpc();

    const drawAccount = await program.account.draw.fetch(drawStatePda);
    expect(drawAccount.randomnessRequested).to.equal(true);
    expect(drawAccount.randomnessAccount.toBase58()).to.equal(
      randomnessAccountData.publicKey.toBase58()
    );
  });

  it("fulfill_randomness", async () => {
    const mockSeed = Array.from({ length: 32 }, (_, i) => i + 1);

    await (program.methods
      .fulfillRandomness(mockSeed)
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        draw: drawStatePda,
      }).rpc();

    const drawAccount = await program.account.draw.fetch(drawStatePda);
    expect(drawAccount.randomnessFulfilled).to.equal(true);
  });

  it("close_draw", async () => {
    await (program.methods
      .closeDraw()
      .accounts as any)({
        globalState,
        draw: drawStatePda,
        randomnessAccountData: randomnessAccountData.publicKey,
      }).rpc();

    const drawAccount = await program.account.draw.fetch(drawStatePda);
    expect(drawAccount.isClosed).to.equal(true);
    expect(Number(drawAccount.status)).to.equal(1);
  });

  it("settle_tickets", async () => {
    await (program.methods
      .settleTickets(1)
      .accounts as any)({
        draw: drawStatePda,
      }).remainingAccounts([
        { pubkey: ticket, isWritable: true, isSigner: false },
      ]).rpc();

    const drawAccount = await program.account.draw.fetch(drawStatePda);
    const ticketAccount = await program.account.ticket.fetch(ticket);

    expect(ticketAccount.settled).to.equal(true);
    expect(Number(drawAccount.ticketsProcessed)).to.equal(1);
    expect(drawAccount.settlementComplete).to.equal(true);
    expect(Number(drawAccount.status)).to.equal(2);
  });

  it("finalize_payouts", async () => {
    await (program.methods
      .finalizePayouts()
      .accounts as any)({
        globalState,
        draw: drawStatePda,
      }).rpc();

    const drawAccount = await program.account.draw.fetch(drawStatePda);
    expect(Number(drawAccount.status)).to.equal(3);
  });

  it("pay_winners_batch", async () => {
    await (program.methods
      .payWinnersBatch(1)
      .accounts as any)({
        draw: drawStatePda,
        ticket,
        globalState,
        prizeVault,
        userTokenAccount,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const drawAccount = await program.account.draw.fetch(drawStatePda);
    expect(Number(drawAccount.status)).to.equal(3);
  });
});
