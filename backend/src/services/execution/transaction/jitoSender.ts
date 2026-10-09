// backend/src/services/execution/transaction/jitoSender.ts
//
// Implements the send-side of docs/mev-jito-routing-spec.md. This module's
// only job is getting an already-signed transaction onto the network via
// Jito's Block Engine instead of a plain RPC sendRawTransaction call —
// confirmation, retry, and the double-execution guard all stay in
// sender.ts, completely unaware of Jito. Once a bundle lands, its
// transaction is an ordinary on-chain transaction with the ordinary
// signature sender.ts already derives before ever calling this — Jito's
// own bundle IDs are used only for this module's own submission logging,
// never for confirmation. See the spec for why that's a deliberate choice,
// not an oversight.
import axios from "axios";
import bs58 from "bs58";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { getLogger } from "../../../utils/logger.js";

const LOG = getLogger("jito-sender");

const DEFAULT_BLOCK_ENGINE_URL =
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Last-resort fallback only — used exclusively if the live getTipAccounts
// call itself fails. Source: jito-labs/mev-protos sample getTipAccounts
// response. Prefer the live fetch below; this list existing at all is a
// deliberate "don't let one failed RPC call take the tip instruction down
// entirely" safety net, not the primary source of truth.
const FALLBACK_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

let cachedTipAccounts: { accounts: string[]; fetchedAt: number } | null = null;
const TIP_ACCOUNT_CACHE_MS = 60_000;

function blockEngineUrl(): string {
  return process.env.JITO_BLOCK_ENGINE_URL ?? DEFAULT_BLOCK_ENGINE_URL;
}

async function fetchTipAccounts(): Promise<string[]> {
  if (
    cachedTipAccounts &&
    Date.now() - cachedTipAccounts.fetchedAt < TIP_ACCOUNT_CACHE_MS
  ) {
    return cachedTipAccounts.accounts;
  }
  try {
    const { data } = await axios.post(
      blockEngineUrl(),
      { jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] },
      { timeout: 5_000 },
    );
    const accounts: unknown = data?.result;
    if (Array.isArray(accounts) && accounts.length > 0) {
      cachedTipAccounts = {
        accounts: accounts as string[],
        fetchedAt: Date.now(),
      };
      return cachedTipAccounts.accounts;
    }
    throw new Error("getTipAccounts returned no accounts");
  } catch (err: any) {
    LOG.warn(
      { err: err?.message },
      "Failed to fetch live Jito tip accounts — using fallback list",
    );
    return FALLBACK_TIP_ACCOUNTS;
  }
}

/**
 * Builds a tip instruction to a randomly chosen tip account — random
 * selection spreads load across the 8 accounts rather than every bot
 * contending on the same one. Must be included in the SAME transaction
 * being bundled (see the spec on why this project uses single-transaction
 * bundles), not a separate one.
 */
export async function buildJitoTipInstruction(
  payer: PublicKey,
  lamports: number,
): Promise<TransactionInstruction> {
  const accounts = await fetchTipAccounts();
  const chosen = accounts[Math.floor(Math.random() * accounts.length)]!;
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(chosen),
    lamports,
  });
}

export function getJitoTipLamports(): number {
  return Number(process.env.RAYDIUM_JITO_TIP_LAMPORTS ?? 1_000);
}

/**
 * A sender.ts SendTransport (see that file) — submits one already-signed
 * transaction as a single-transaction Jito bundle. Throws on a JSON-RPC
 * error response, a missing result, or a network failure — same contract
 * connection.sendRawTransaction throwing already has, so sender.ts's
 * existing (lack of) retry-on-submission-error behavior applies identically
 * regardless of which transport is in use. See the spec's §5 on why this
 * does NOT automatically fall back to the plain RPC transport on failure.
 */
export async function sendViaJitoBundle(rawTx: Uint8Array): Promise<void> {
  const encoded = bs58.encode(rawTx);
  const { data } = await axios.post(
    blockEngineUrl(),
    {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[encoded]],
    },
    { timeout: 10_000 },
  );

  if (data?.error) {
    throw new Error(`Jito sendBundle error: ${JSON.stringify(data.error)}`);
  }
  if (!data?.result) {
    throw new Error("Jito sendBundle returned no bundle id");
  }
  LOG.info({ bundleId: data.result }, "Submitted as a Jito bundle");
}
