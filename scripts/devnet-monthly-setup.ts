/**
 * PARTE B do upgrade do ciclo mensal na devnet — setup de contas.
 * Um passo por vez (STEP=1|2|3), conferindo antes do proximo.
 *
 *   STEP=1  init_monthly_state   (cria monthly-state-v3)
 *   STEP=2  init_monthly_vault   (cria monthly-vault-v3, grava em monthly_state)
 *   STEP=3  set_crypto_count(10) (global_state.crypto_count 1 -> 10)
 *
 * Assina como admin (= global_state.admin). Rode com:
 *   ANCHOR_PROVIDER_URL=<helius> ANCHOR_WALLET=~/.config/solana/id.json \
 *   STEP=1 npx ts-node scripts/devnet-monthly-setup.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getMint } from "@solana/spl-token";
import * as fs from "fs";

const IDL = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/megabyt.json", "utf8"));

(async function () {
  const step = Number(process.env.STEP || "0");
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL as anchor.Idl, provider);
  const pid = program.programId;
  const admin = provider.wallet.publicKey;

  const pda = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s)], pid)[0];
  const globalState = pda("global-state-v3");
  const monthlyState = pda("monthly-state-v3");
  const monthlyVault = pda("monthly-vault-v3");
  const vaultAuthority = pda("vault-authority-v3");

  console.log("cluster     :", provider.connection.rpcEndpoint.replace(/api-key=[^&]+/, "api-key=***"));
  console.log("program     :", pid.toBase58());
  console.log("admin (signer):", admin.toBase58());
  console.log("global-state :", globalState.toBase58());
  console.log("monthly-state:", monthlyState.toBase58());
  console.log("monthly-vault:", monthlyVault.toBase58());
  console.log("vault-auth   :", vaultAuthority.toBase58());
  console.log("STEP         :", step);
  console.log("");

  const gs: any = await (program.account as any).globalState.fetch(globalState);
  if (gs.admin.toBase58() !== admin.toBase58()) {
    throw new Error(`wallet (${admin.toBase58()}) != global_state.admin (${gs.admin.toBase58()})`);
  }

  const confirm = async (sig: string) => {
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      "confirmed"
    );
  };

  if (step === 1) {
    const before = await provider.connection.getAccountInfo(monthlyState);
    if (before) throw new Error("monthly-state-v3 JA existe — abortando");

    const sig = await (program.methods.initMonthlyState().accounts as any)({
      admin,
      globalState,
      monthlyState,
      systemProgram: SystemProgram.programId,
    }).rpc();
    await confirm(sig);
    console.log("init_monthly_state tx:", sig);
    console.log("");

    const ms: any = await (program.account as any).monthlyState.fetch(monthlyState);
    console.log("--- monthly_state on-chain ---");
    console.log("monthly_vault       :", ms.monthlyVault.toBase58(), "(esperado: 11111111111111111111111111111111)");
    console.log("current_monthly_id  :", Number(ms.currentMonthlyId));
    console.log("total_monthly_draws :", Number(ms.totalMonthlyDraws));
    console.log("jackpot_carry       :", Number(ms.jackpotCarry));
    console.log("last_monthly_open_at:", Number(ms.lastMonthlyOpenAt));
    console.log("last_covered_draw_id:", Number(ms.lastCoveredDrawId));
    console.log("bump                :", ms.bump);

    const zeroed =
      ms.monthlyVault.equals(PublicKey.default) &&
      Number(ms.currentMonthlyId) === 0 &&
      Number(ms.totalMonthlyDraws) === 0 &&
      Number(ms.jackpotCarry) === 0 &&
      Number(ms.lastMonthlyOpenAt) === 0 &&
      Number(ms.lastCoveredDrawId) === 0;
    console.log("");
    console.log(zeroed ? "OK: monthly_state criado e zerado" : "ATENCAO: monthly_state NAO esta todo zerado");
  }

  if (step === 2) {
    const ms0 = await provider.connection.getAccountInfo(monthlyState);
    if (!ms0) throw new Error("monthly-state-v3 nao existe — rode STEP=1 primeiro");
    const before = await provider.connection.getAccountInfo(monthlyVault);
    if (before) throw new Error("monthly-vault-v3 JA existe — abortando");

    const tokenMint: PublicKey = gs.tokenMint;
    console.log("token_mint (do global_state):", tokenMint.toBase58());

    const sig = await (program.methods.initMonthlyVault().accounts as any)({
      admin,
      globalState,
      monthlyState,
      tokenMint,
      monthlyVault,
      vaultAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();
    await confirm(sig);
    console.log("init_monthly_vault tx:", sig);
    console.log("");

    const vault = await getAccount(provider.connection, monthlyVault);
    const mintInfo = await getMint(provider.connection, tokenMint);
    const ms: any = await (program.account as any).monthlyState.fetch(monthlyState);

    console.log("--- monthly-vault-v3 (SPL token account) ---");
    console.log("mint     :", vault.mint.toBase58(), vault.mint.equals(tokenMint) ? "OK (== token_mint)" : "MISMATCH");
    console.log("owner    :", vault.owner.toBase58(), vault.owner.equals(vaultAuthority) ? "OK (== vault-authority-v3)" : "MISMATCH");
    console.log("amount   :", vault.amount.toString(), vault.amount.toString() === "0" ? "OK (0)" : "ATENCAO nao-zero");
    console.log("decimals :", mintInfo.decimals);
    console.log("");
    console.log("--- monthly_state.monthly_vault ---");
    console.log("aponta pra:", ms.monthlyVault.toBase58(), ms.monthlyVault.equals(monthlyVault) ? "OK (== monthly-vault-v3)" : "MISMATCH");
  }

  if (step === 3) {
    console.log("crypto_count ANTES:", Number(gs.cryptoCount));
    const sig = await (program.methods.setCryptoCount(10).accounts as any)({
      admin,
      globalState,
    }).rpc();
    await confirm(sig);
    console.log("set_crypto_count(10) tx:", sig);
    console.log("");

    const gs2: any = await (program.account as any).globalState.fetch(globalState);
    console.log("crypto_count DEPOIS:", Number(gs2.cryptoCount), Number(gs2.cryptoCount) === 10 ? "OK" : "FALHOU");
    console.log("numbers_count      :", Number(gs2.numbersCount), "(nao deve ter mudado)");
    console.log("current_phase      :", Number(gs2.currentPhase), "(nao deve ter mudado)");
  }

  if (![1, 2, 3].includes(step)) {
    console.log("defina STEP=1, 2 ou 3");
    process.exit(1);
  }
})().catch((e) => {
  console.error("ERRO:", e.message || e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
