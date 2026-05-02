import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Commitment,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";

// =========================
// CONFIG
// =========================

const RPC_URL =
  process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

const WALLET_PATH =
  process.env.ANCHOR_WALLET ||
  path.join(process.env.HOME || "", ".config/solana/id.json");

const COMMITMENT: Commitment = "confirmed";

const MAX_BATCH_SIZE = 10;
const MAX_WAIT_MS = 3000;
const MAX_CONCURRENCY = 2;
const RETRY_LIMIT = 3;

const PRIORITY_UNIT_LIMIT = 400_000;
const PRIORITY_UNIT_PRICE_MICROLAMPORTS = 5_000;

// =========================
// TYPES
// =========================

type QueueStatus =
  | "queued"
  | "processing"
  | "confirmed"
  | "failed"
  | "retrying";

type TicketRequest = {
  requestId: string;
  userSecretKey?: number[];
  userPubkey?: string;
  numbers: number[];
  crypto: number;
  enqueuedAt: number;
  retries: number;
  status: QueueStatus;
  lastError?: string;
};

type QueueProcessResult = {
  requestId: string;
  ok: boolean;
  signature?: string;
  error?: string;
};

// =========================
// GLOBALS
// =========================

let ticketBuffer: TicketRequest[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let isFlushing = false;
let requestCounter = 0;

// =========================
// HELPERS
// =========================

function loadKeypairFromFile(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function generateRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now()}-${requestCounter}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function assertTicketNumbers(numbers: number[]) {
  if (!Array.isArray(numbers) || numbers.length !== 6) {
    throw new Error("numbers must contain exactly 6 values");
  }

  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > 72) {
      throw new Error(`invalid ticket number: ${n}`);
    }
  }

  const unique = new Set(numbers);
  if (unique.size !== 6) {
    throw new Error("ticket numbers must be unique");
  }
}

function assertCryptoNumber(crypto: number) {
  if (!Number.isInteger(crypto) || crypto < 1 || crypto > 10) {
    throw new Error(`invalid crypto number: ${crypto}`);
  }
}

function getUserKeypair(req: TicketRequest): Keypair {
  if (req.userSecretKey && req.userSecretKey.length > 0) {
    return Keypair.fromSecretKey(Uint8Array.from(req.userSecretKey));
  }

  throw new Error(
    `request ${req.requestId} has no userSecretKey; current batcher expects local test/dev wallets`
  );
}

// =========================
// PROVIDER / PROGRAM
// =========================

function buildProviderAndProgram() {
  const admin = loadKeypairFromFile(WALLET_PATH);
  const connection = new Connection(RPC_URL, COMMITMENT);

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT,
  });

  anchor.setProvider(provider);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const idl = require("../target/idl/megabyt.json");
  const programId = new PublicKey(idl.address);
  const program = new Program(idl, provider) as Program;

  return {
    admin,
    connection,
    provider,
    program,
    programId,
  };
}

// =========================
// PDA HELPERS
// =========================

function deriveGlobalStatePda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-state-v2")],
    programId
  );
  return pda;
}

function deriveVaultAuthorityPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-authority")],
    programId
  );
  return pda;
}

function derivePrizeVaultPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("prize-vault")],
    programId
  );
  return pda;
}

function deriveDrawPda(programId: PublicKey, drawId: BN): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw"), drawId.toArrayLike(Buffer, "le", 8)],
    programId
  );
  return pda;
}

function deriveTicketPda(
  programId: PublicKey,
  drawState: PublicKey,
  user: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), drawState.toBuffer(), user.toBuffer()],
    programId
  );
  return pda;
}

// =========================
// ON-CHAIN HELPERS
// =========================

async function fetchGlobalStateAccount(
  program: Program,
  globalState: PublicKey
): Promise<any> {
  const acc = await (program.account as any).globalState.fetch(globalState);
  return acc;
}

async function processSingleBuyTicket(
  program: Program,
  programId: PublicKey,
  req: TicketRequest
): Promise<QueueProcessResult> {
  try {
    assertTicketNumbers(req.numbers);
    assertCryptoNumber(req.crypto);

    const user = getUserKeypair(req);
    const globalState = deriveGlobalStatePda(programId);
    const vaultAuthority = deriveVaultAuthorityPda(programId);
    const prizeVault = derivePrizeVaultPda(programId);

    const global = await fetchGlobalStateAccount(program, globalState);
    const currentDrawId = new BN(global.currentDrawId);
    const drawState = deriveDrawPda(programId, currentDrawId);

    const ticket = deriveTicketPda(programId, drawState, user.publicKey);

    const usdtMint = new PublicKey(global.usdtMint);
    const userTokenAccount = getAssociatedTokenAddressSync(
      usdtMint,
      user.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const numbersArg = req.numbers.map((n) => Number(n));
    const cryptoArg = Number(req.crypto);

    const ixComputeLimit = ComputeBudgetProgram.setComputeUnitLimit({
      units: PRIORITY_UNIT_LIMIT,
    });

    const ixComputePrice = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_UNIT_PRICE_MICROLAMPORTS,
    });

    const txSig = await program.methods
      .buyTicket(numbersArg, cryptoArg)
      .accounts({
        buyer: user.publicKey,
        globalState,
        drawState,
        ticket,
        prizeVault,
        vaultAuthority,
        userTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([ixComputeLimit, ixComputePrice])
      .signers([user])
      .rpc({ commitment: COMMITMENT });

    return {
      requestId: req.requestId,
      ok: true,
      signature: txSig,
    };
  } catch (err: any) {
    return {
      requestId: req.requestId,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

// =========================
// QUEUE
// =========================

export function enqueueTicket(input: {
  userSecretKey: number[];
  numbers: number[];
  crypto: number;
}): TicketRequest {
  assertTicketNumbers(input.numbers);
  assertCryptoNumber(input.crypto);

  const req: TicketRequest = {
    requestId: generateRequestId(),
    userSecretKey: input.userSecretKey,
    numbers: input.numbers,
    crypto: input.crypto,
    enqueuedAt: Date.now(),
    retries: 0,
    status: "queued",
  };

  ticketBuffer.push(req);

  console.log(
    `[QUEUE] + ${req.requestId} | size=${ticketBuffer.length} | numbers=${req.numbers.join(
      ","
    )} | crypto=${req.crypto}`
  );

  if (ticketBuffer.length >= MAX_BATCH_SIZE) {
    void flushQueue("size");
  } else {
    scheduleFlushTimer();
  }

  return req;
}

function scheduleFlushTimer() {
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (ticketBuffer.length > 0) {
      void flushQueue("time");
    }
  }, MAX_WAIT_MS);
}

async function flushQueue(reason: "size" | "time" | "manual") {
  if (isFlushing) return;
  if (ticketBuffer.length === 0) return;

  isFlushing = true;

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const batch = ticketBuffer.splice(0, MAX_BATCH_SIZE);

  console.log(
    `\n[FLUSH] reason=${reason} | batch=${batch.length} | remaining=${ticketBuffer.length}`
  );

  try {
    const { program, programId } = buildProviderAndProgram();

    const groups = chunkArray(batch, MAX_CONCURRENCY);

    for (const group of groups) {
      await Promise.all(
        group.map(async (req) => {
          req.status = "processing";

          const res = await processSingleBuyTicket(program, programId, req);

          if (res.ok) {
            req.status = "confirmed";
            console.log(
              `[OK] ${req.requestId} confirmed | sig=${res.signature}`
            );
            return;
          }

          req.retries += 1;
          req.lastError = res.error || "unknown error";

          if (req.retries <= RETRY_LIMIT) {
            req.status = "retrying";
            console.log(
              `[RETRY] ${req.requestId} attempt=${req.retries} error=${req.lastError}`
            );
            await sleep(500 * req.retries);
            ticketBuffer.push(req);
          } else {
            req.status = "failed";
            console.log(`[FAIL] ${req.requestId} error=${req.lastError}`);
          }
        })
      );
    }
  } catch (err: any) {
    console.error(`[FLUSH-ERROR] ${err?.message || String(err)}`);

    for (const req of batch) {
      req.retries += 1;
      req.lastError = err?.message || String(err);

      if (req.retries <= RETRY_LIMIT) {
        req.status = "retrying";
        ticketBuffer.push(req);
      } else {
        req.status = "failed";
      }
    }
  } finally {
    isFlushing = false;

    if (ticketBuffer.length > 0) {
      scheduleFlushTimer();
    }
  }
}

// =========================
// DEMO / LOCAL TEST DRIVER
// =========================

function buildFakeSequentialTicket(seed: number): {
  numbers: number[];
  crypto: number;
} {
  const base = ((seed - 1) % 60) + 1;
  const nums = [base, base + 1, base + 2, base + 3, base + 4, base + 5].map(
    (n) => ((n - 1) % 72) + 1
  );
  const unique = Array.from(new Set(nums));

  while (unique.length < 6) {
    const next = ((unique[unique.length - 1] + 1 - 1) % 72) + 1;
    if (!unique.includes(next)) unique.push(next);
  }

  return {
    numbers: unique,
    crypto: ((seed - 1) % 10) + 1,
  };
}

async function main() {
  console.log("=== MegaByt Off-chain Batcher ===");
  console.log("RPC:", RPC_URL);
  console.log("Wallet:", WALLET_PATH);
  console.log("MAX_BATCH_SIZE:", MAX_BATCH_SIZE);
  console.log("MAX_WAIT_MS:", MAX_WAIT_MS);
  console.log("MAX_CONCURRENCY:", MAX_CONCURRENCY);

  const admin = loadKeypairFromFile(WALLET_PATH);
  console.log("Admin pubkey:", admin.publicKey.toBase58());

  // DEMO:
  // por enquanto, para validar a estrutura,
  // enfileiramos 3 compras usando o mesmo wallet.
  //
  // ATENÇÃO:
  // no seu contrato atual isso provavelmente vai confirmar só a primeira,
  // porque ticket PDA = [ticket, draw_state, user]
  // e isso limita 1 ticket por usuário por draw.
  //
  // Mesmo assim, o batcher já serve para validar a fila, flush e retry.
  for (let i = 1; i <= 3; i++) {
    const demo = buildFakeSequentialTicket(i);

    enqueueTicket({
      userSecretKey: Array.from(admin.secretKey),
      numbers: demo.numbers,
      crypto: demo.crypto,
    });
  }

  // mantém processo vivo
  setInterval(() => {
    const queued = ticketBuffer.filter((x) => x.status === "queued").length;
    const retrying = ticketBuffer.filter((x) => x.status === "retrying").length;

    process.stdout.write(
      `\r[HEARTBEAT] buffer=${ticketBuffer.length} queued=${queued} retrying=${retrying}     `
    );
  }, 1000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

