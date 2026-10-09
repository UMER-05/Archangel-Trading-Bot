/**
 * Batch get balances for multiple public keys using getMultipleAccountsInfo
 */
export async function getBalances(
  pubkeys: (PublicKey | string)[]
): Promise<number[]> {
  const conn = getConnection();
  const keys = pubkeys.map((k) => new PublicKey(k));
  const infos = await conn.getMultipleAccountsInfo(keys, COMMITMENT);
  return infos.map((info) => (info ? info.lamports : 0));
}
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getLogger } from "../utils/logger.js";

const log = getLogger("solana.service");

const COMMITMENT: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) ?? "confirmed";

let _connection: Connection | null = null;

/**
 * 🧠 Singleton Solana RPC connection
 * Uses Helius RPC when SOLANA_RPC_URL is set to Helius endpoint in .env
 * This connection is used for all blockchain reads, transaction submission, and metadata queries
 */
export function getConnection(): Connection {
  if (!_connection) {
    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    _connection = new Connection(rpcUrl, COMMITMENT);
    log.info(
      `✅ RPC connected → ${
        rpcUrl.includes("helius") ? "Helius" : "Custom"
      } (commitment=${COMMITMENT})`
    );
  }
  return _connection;
}

/**
 * Optional WebSocket connection
 */

let _wsConnection: Connection | null = null;
let wsRetry = 0;
function getBackoffDelay() {
  const base = Math.min(1000 * 2 ** wsRetry, 30000);
  const jitter = Math.random() * 1000;
  wsRetry++;
  return base + jitter;
}
export function getWsConnection(): Connection | null {
  const wsUrl = process.env.SOLANA_WS_URL;
  if (!_wsConnection && wsUrl) {
    try {
      _wsConnection = new Connection(wsUrl, COMMITMENT);
      log.info(`WS connected → ${wsUrl}`);
      wsRetry = 0; // Reset retry after stable connection
    } catch (err) {
      const delay = getBackoffDelay();
      log.warn(
        { delay },
        `WS connection failed, retrying in ${Math.round(delay)}ms`
      );
      setTimeout(() => getWsConnection(), delay);
    }
  }
  return _wsConnection;
}

/**
 * 🔐 Load backend signer wallet from env.
 * Prefers WALLET_PRIVATE_KEY / WALLET_SECRET_KEY (the validated key this bot actually
 * trades with everywhere else) over the legacy SECRET_KEY var, which has been observed
 * corrupted/truncated in this project's .env and should not be relied on.
 * Supports both base58 string and JSON array format.
 */
export function loadKeypairFromEnv(): Keypair {
  const raw = (
    process.env.WALLET_PRIVATE_KEY ||
    process.env.WALLET_SECRET_KEY ||
    process.env.SECRET_KEY ||
    ""
  ).trim();
  if (!raw) throw new Error("WALLET_SECRET_KEY (or WALLET_PRIVATE_KEY) missing");

  try {
    // Try parsing as JSON array first
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length >= 64) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch {
    // Not JSON, try as base58 string
    try {
      const decoded = bs58.decode(raw);
      return Keypair.fromSecretKey(decoded);
    } catch (err) {
      log.error(
        { error: (err as Error).message },
        "Failed to decode wallet secret key as base58"
      );
    }
  }

  throw new Error(
    "WALLET_SECRET_KEY must be either a JSON array [0,1,2,...] or base58 string"
  );
}

/**
 * Canonical form of a Solana address for use as a DB/identity key.
 *
 * Solana addresses are base58 and case-sensitive — unlike EVM addresses,
 * there is no valid alternate-casing representation, so lowercasing would
 * corrupt them rather than normalize them. PublicKey's constructor already
 * validates the input is well-formed (right length, valid base58, on the
 * ed25519 curve's byte range) and .toBase58() gives back its one canonical
 * encoding, which is all the "normalization" a Solana address needs or
 * should get. Throws on malformed input — callers should treat that as a
 * bad request, not silently fall back to the raw string.
 */
export function normalizeWalletAddress(address: string): string {
  return new PublicKey(address.trim()).toBase58();
}

/**
 * 🌐 Get wallet balance (in lamports)
 */
export async function getBalance(pubkey: PublicKey | string) {
  const conn = getConnection();
  const pk = new PublicKey(pubkey);
  return conn.getBalance(pk, COMMITMENT);
}

/**
 * 💰 Get wallet balance in SOL
 */
export async function getBalanceInSol(
  pubkey: PublicKey | string
): Promise<number> {
  try {
    const lamports = await getBalance(pubkey);
    const sol = lamports / 1e9; // Convert lamports to SOL

    log.debug(
      {
        wallet:
          typeof pubkey === "string"
            ? pubkey.slice(0, 8) + "..."
            : pubkey.toBase58().slice(0, 8) + "...",
        lamports,
        sol: sol.toFixed(4),
        
      },
      "Fetched wallet balance"
    );

    return sol;
  } catch (err) {
    log.error(
      {
        wallet: typeof pubkey === "string" ? pubkey : pubkey.toBase58(),
        error: (err as Error).message,
      },
      "Failed to fetch wallet balance"
    );
    return 0;
  }
}

// Every SPL token program a wallet's holdings might be under — the legacy
// Token program and Token-2022 are different on-chain programs, and
// getParsedTokenAccountsByOwner only searches one at a time.
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

/**
 * 🪙 Real on-chain SPL token balance for (wallet, mint) — the actual holding,
 * not a DB-derived approximation from cumulative buy/sell records (which can
 * drift from on-chain truth from unrecorded transfers, rounding, etc). Used
 * to size a "sell my entire holding" request against what's really there.
 */
export async function getTokenBalance(
  walletAddress: string,
  mint: string
): Promise<{ raw: string; uiAmount: number; decimals: number }> {
  const conn = getConnection();
  const owner = new PublicKey(walletAddress);
  const mintPk = new PublicKey(mint);

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const resp = await conn.getParsedTokenAccountsByOwner(owner, {
      mint: mintPk,
      programId,
    });
    if (resp.value.length > 0) {
      // A wallet can (rarely) hold more than one token account for the same
      // mint — sum them rather than just reading the first.
      let rawTotal = 0n;
      let decimals = 0;
      let uiAmount = 0;
      for (const { account } of resp.value) {
        const info = (account.data as any).parsed.info.tokenAmount;
        rawTotal += BigInt(info.amount);
        decimals = info.decimals;
        uiAmount += info.uiAmount ?? 0;
      }
      return { raw: rawTotal.toString(), uiAmount, decimals };
    }
  }

  return { raw: "0", uiAmount: 0, decimals: 0 };
}

/**
 * ✅ Check if wallet has sufficient balance for trade
 * @param pubkey - Wallet public key
 * @param amountSol - Required amount in SOL
 * @param bufferPct - Safety buffer percentage (default 5% for fees)
 * @returns true if sufficient balance exists
 */
export async function hasSufficientBalance(
  pubkey: PublicKey | string,
  amountSol: number,
  bufferPct: number = 0.05
): Promise<boolean> {
  const balance = await getBalanceInSol(pubkey);
  const requiredWithBuffer = amountSol * (1 + bufferPct);

  log.info(
    {
      balance: balance.toFixed(4),
      required: amountSol.toFixed(4),
      requiredWithBuffer: requiredWithBuffer.toFixed(4),
      sufficient: balance >= requiredWithBuffer,
    },
    "Balance check"
  );

  return balance >= requiredWithBuffer;
}

/**
 * 🚀 Safe swap executor with retry & strong confirmation
 */
export async function signAndSendVersionedTx(
  tx: VersionedTransaction,
  signer = loadKeypairFromEnv(),
  maxRetries = 3
) {
  const conn = getConnection();

  tx.sign([signer]);
  const raw = tx.serialize();

  let signature: string | null = null;
  let attempt = 0;

  // retry sending transaction
  while (!signature && attempt < maxRetries) {
    try {
      signature = await conn.sendRawTransaction(raw, {
        skipPreflight: false,
      });
    } catch (err) {
      log.warn(
        { attempt, err: (err as Error).message },
        "sendRawTransaction retry"
      );
      attempt++;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  if (!signature) {
    throw new Error("Failed to send transaction after retries");
  }

  const latest = await conn.getLatestBlockhash("confirmed");

  await conn.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  log.info({ signature }, "Txn confirmed");

  return signature;
}
