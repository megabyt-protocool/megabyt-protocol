import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const COMMITMENT: anchor.web3.Commitment = "confirmed";

async function main() {
  console.log("=== MegaByt Init V3 Devnet ===");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const admin = wallet.payer;
  const program = anchor.workspace.Megabyt as Program;

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Program:", program.programId.toBase58());
  console.log("RPC:", connection.rpcEndpoint);

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v3")],
    program.programId
  );

  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority-v3")],
    program.programId
  );

  const [prizeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("prize-vault-v3")],
    program.programId
  );

  const [treasuryVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury-vault-v3")],
    program.programId
  );

  const [legalVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("legal-vault-v3")],
    program.programId
  );

  const [marketingVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("marketing-vault-v3")],
    program.programId
  );

  const [liquidityVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity-vault-v3")],
    program.programId
  );

  console.log("GlobalState:", globalState.toBase58());
  console.log("VaultAuthority:", vaultAuthority.toBase58());
  console.log("PrizeVault PDA:", prizeVault.toBase58());

  let globalExists = false;
  let existingGlobal: any = null;

  try {
    existingGlobal = await (program.account as any).globalState.fetch(globalState);
    globalExists = true;
    console.log("GlobalState v3 já existe.");
  } catch {
    globalExists = false;
    console.log("GlobalState v3 ainda não existe.");
  }

  let usdtMint: PublicKey;
  let bytiMint: PublicKey;

  if (globalExists) {
    usdtMint = new PublicKey(
      existingGlobal.usdtMint ?? existingGlobal.usdt_mint
    );
    bytiMint = new PublicKey(
      existingGlobal.bytiMint ?? existingGlobal.byti_mint
    );

    console.log("Reusando mints do GlobalState existente.");
    console.log("USDT Mint:", usdtMint.toBase58());
    console.log("BYTI Mint:", bytiMint.toBase58());
  } else {
    usdtMint = await createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    bytiMint = await createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    console.log("USDT Mint:", usdtMint.toBase58());
    console.log("BYTI Mint:", bytiMint.toBase58());

    console.log("\n=== Step 1: initialize(global-state-v3) ===");

    const sigInit = await (program.methods as any)
      .initialize(
        admin.publicKey,
        new BN(1_000_000),
        usdtMint,
        bytiMint
      )
      .accounts({
        admin: admin.publicKey,
        globalState,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc({ commitment: COMMITMENT });

    console.log("Initialize sig:", sigInit);
  }

  console.log("\n=== Step 2: initialize_vaults ===");

  const sigVaults = await (program.methods as any)
    .initializeVaults()
    .accounts({
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
    })
    .signers([admin])
    .rpc({ commitment: COMMITMENT });

  console.log("InitializeVaults sig:", sigVaults);

  const global: any = await (program.account as any).globalState.fetch(globalState);

  console.log("\n=== FINAL STATE ===");
  console.log("globalState:", globalState.toBase58());
  console.log(
    "usdtMint:",
    global.usdtMint?.toBase58 ? global.usdtMint.toBase58() : String(global.usdtMint)
  );
  console.log(
    "bytiMint:",
    global.bytiMint?.toBase58 ? global.bytiMint.toBase58() : String(global.bytiMint)
  );
  console.log(
    "tokenMint:",
    global.tokenMint?.toBase58 ? global.tokenMint.toBase58() : String(global.tokenMint)
  );
  console.log(
    "prizeVault:",
    global.prizeVault?.toBase58 ? global.prizeVault.toBase58() : String(global.prizeVault)
  );
  console.log(
    "treasuryVault:",
    global.treasuryVault?.toBase58 ? global.treasuryVault.toBase58() : String(global.treasuryVault)
  );

  const prizeVaultAcc = await getAccount(connection, prizeVault, COMMITMENT);
  console.log("PrizeVault mint:", prizeVaultAcc.mint.toBase58());
  console.log("PrizeVault owner:", prizeVaultAcc.owner.toBase58());
}

main().catch((err) => {
  console.error("Init v3 failed:");
  console.error(err);
  process.exit(1);
});

