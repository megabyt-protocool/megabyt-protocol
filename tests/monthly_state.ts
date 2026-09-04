import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, createMint, getAccount } from "@solana/spl-token";
import { SystemProgram, PublicKey } from "@solana/web3.js";
import { Megabyt } from "../target/types/megabyt";

/**
 * Valida a ETAPA 2 do sorteio mensal: só criação de estado, sem lógica de
 * sorteio (open/close/settle/pay mensal ficam pra próximas etapas).
 *
 *  1. init_monthly_state cria o singleton MonthlyState com os defaults certos.
 *  2. init_monthly_vault cria o vault SPL dedicado, vinculado ao mesmo mint
 *     do prize_vault, e grava sua pubkey em MonthlyState.
 *  3. O bug do monthly_cycle_duration=0 foi corrigido: global_state sai do
 *     initialize com um ciclo mensal real (30 dias), não 0/0.
 *
 * Independente de tests/megabyt.ts e tests/pay_winners_batch.ts: reaproveita
 * o global_state se ele já existir na mesma validator, ou inicializa do zero.
 */
describe("sorteio mensal — Etapa 2 (só estado)", () => {
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
  const [monthlyState] = PublicKey.findProgramAddressSync(
    [Buffer.from("monthly-state-v3")], program.programId
  );
  const [monthlyVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("monthly-vault-v3")], program.programId
  );

  let mint: PublicKey;

  before(async () => {
    const sig = await connection.requestAirdrop(admin.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
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

      await (program.methods
        .initialize(admin.publicKey, new anchor.BN(1_000_000), usdtMint, bytiMint)
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
    }
  });

  it("global_state sai do initialize com um ciclo mensal real (fix do bug duration=0)", async () => {
    const globalAccount: any = await program.account.globalState.fetch(globalState);

    // 30 dias em segundos — MONTHLY_CYCLE_DURATION_SECONDS em constants.rs
    expect(Number(globalAccount.monthlyCycleDuration)).to.equal(30 * 24 * 3600);
    expect(Number(globalAccount.monthlyCycleStart)).to.be.greaterThan(0);
  });

  // Nota de robustez: este arquivo não controla se é o PRIMEIRO a rodar
  // dentro do `anchor test` completo — outros arquivos (ex:
  // monthly_close_draw.ts) também precisam de MonthlyState/monthly_vault
  // prontos e os criam defensivamente se ainda não existirem. Por isso os
  // testes abaixo checam se a conta já existe antes de tentar criá-la de
  // novo (senão dá "already in use"), em vez de assumir que são os
  // primeiros.

  it("init_monthly_state: cria o singleton (ou confirma que já existe) com os defaults certos", async () => {
    let existing: any = null;
    try {
      existing = await program.account.monthlyState.fetch(monthlyState);
    } catch (_e) {
      existing = null;
    }

    if (existing) {
      console.log("    [info] MonthlyState já existia (outro arquivo de teste criou primeiro) — só confirmando leitura.");
      expect(typeof existing.bump).to.equal("number");
      return;
    }

    await (program.methods
      .initMonthlyState()
      .accounts as any)({
        admin: admin.publicKey,
        globalState,
        monthlyState,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const state: any = await program.account.monthlyState.fetch(monthlyState);

    expect(state.monthlyVault.toBase58()).to.equal(PublicKey.default.toBase58());
    expect(Number(state.currentMonthlyId)).to.equal(0);
    expect(Number(state.totalMonthlyDraws)).to.equal(0);
    expect(Number(state.jackpotCarry)).to.equal(0);
    expect(Number(state.lastMonthlyOpenAt)).to.equal(0);
    expect(Number(state.lastCoveredDrawId)).to.equal(0);
  });

  it("init_monthly_vault rejeita um mint diferente do prize_vault", async function () {
    // Só faz sentido enquanto o monthly_vault (PDA singleton) ainda não
    // existe — depois de criado uma vez, não dá mais pra testar rejeição
    // na criação nesta run. Se outro arquivo já criou, pula.
    const info = await connection.getAccountInfo(monthlyVault);
    if (info) {
      console.log("    [skip] monthly_vault já foi criado por outro arquivo — não dá pra testar rejeição de mint numa conta singleton já existente.");
      this.skip();
      return;
    }

    const wrongMint = await createMint(connection, admin, admin.publicKey, null, 6);

    let threw = false;
    try {
      await (program.methods
        .initMonthlyVault()
        .accounts as any)({
          admin: admin.publicKey,
          globalState,
          monthlyState,
          tokenMint: wrongMint,
          monthlyVault,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).rpc();
    } catch (_e) {
      threw = true;
    }

    expect(threw).to.equal(true, "init_monthly_vault deveria rejeitar um mint diferente do prize_vault");

    // Confirma que nada foi criado pela tentativa rejeitada.
    const infoAfter = await connection.getAccountInfo(monthlyVault);
    expect(infoAfter).to.equal(null);
  });

  it("init_monthly_vault: cria o vault dedicado (ou confirma que já existe) com o mint certo", async () => {
    const info = await connection.getAccountInfo(monthlyVault);

    if (!info) {
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
    } else {
      console.log("    [info] monthly_vault já existia (outro arquivo de teste criou primeiro) — só confirmando estado.");
    }

    const vaultAccount = await getAccount(connection, monthlyVault);
    expect(vaultAccount.mint.toBase58()).to.equal(mint.toBase58());
    expect(vaultAccount.owner.toBase58()).to.equal(vaultAuthority.toBase58());

    const state: any = await program.account.monthlyState.fetch(monthlyState);
    expect(state.monthlyVault.toBase58()).to.equal(monthlyVault.toBase58());
  });
});
