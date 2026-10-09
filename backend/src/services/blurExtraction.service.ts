// backend/src/services/blurExtraction.service.ts
//
// Adapter from a Solami Blur `pool_create` stream event into ArchAngel's
// CandidateMint shape (see tokenExtraction.service.ts).
//
// Blur's pool_create is FLAT:
//
//   {
//     type: "pool_create",
//     signature, slot, block_time,   // block_time: unix seconds (integer)
//     dex: "raydium_launchpad",
//     mint, pool, base_mint, quote_mint, creator,
//     indexed_at                     // unix ms, when Blur indexed it
//   }
//
// Acceptance rule: exactly one side of the pair must be SOL/USDC/USDT, and
// the other side is the candidate mint. A pool quoted in some other token
// (common for launchpad tokens) has no supported quote side and is rejected
// here — that is the filter working, not a parsing failure.

import { PublicKey } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import type { CandidateMint } from "./tokenExtraction.service.js";

const LOG = getLogger("blur-extraction");

// The only quote assets ArchAngel treats as valid trading-pair quote
// currencies.
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

function isValidPubkeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32) return false;

  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function extractCandidateMintFromBlurEvent(
  body: unknown,
): CandidateMint | null {
  if (typeof body !== "object" || body === null) {
    LOG.warn("Blur frame was not an object — rejecting");
    return null;
  }

  const event = body as Record<string, unknown>;

  if (event.type !== "pool_create") {
    return null;
  }

  const blockTime = event.block_time;
  if (
    typeof blockTime !== "number" ||
    !Number.isFinite(blockTime) ||
    blockTime <= 0
  ) {
    LOG.warn(
      { blockTime },
      "Blur pool_create missing/invalid block_time — rejecting",
    );
    return null;
  }

  // Docs list both `mint` and `base_mint` on pool_create; prefer base_mint
  // (it pairs with quote_mint) and fall back to mint.
  const baseMint = event.base_mint ?? event.mint;
  const quoteMint = event.quote_mint;
  const poolAddress = event.pool;
  const dex = event.dex;

  if (!isValidPubkeyString(baseMint)) {
    LOG.warn(
      { baseMint },
      "Blur pool_create has invalid base_mint — rejecting",
    );
    return null;
  }
  if (!isValidPubkeyString(quoteMint)) {
    LOG.warn(
      { quoteMint },
      "Blur pool_create has invalid quote_mint — rejecting",
    );
    return null;
  }
  if (!isValidPubkeyString(poolAddress)) {
    LOG.warn({ poolAddress }, "Blur pool_create has invalid pool — rejecting");
    return null;
  }
  if (typeof dex !== "string" || dex.length === 0) {
    LOG.warn({ dex }, "Blur pool_create missing dex — rejecting");
    return null;
  }

  const baseIsQuote = QUOTE_MINTS.has(baseMint);
  const quoteIsQuote = QUOTE_MINTS.has(quoteMint);

  // Neither side a quote asset -> not a pair we trade. Both sides quote
  // assets -> there is no new token.
  if (baseIsQuote === quoteIsQuote) {
    LOG.debug(
      {
        baseMint: baseMint.slice(0, 8),
        quoteMint: quoteMint.slice(0, 8),
        dex,
      },
      "Blur pool_create does not contain exactly one supported quote mint — rejecting",
    );
    return null;
  }

  return {
    mint: baseIsQuote ? quoteMint : baseMint,
    poolAddress,
    dex,
    poolCreatedAt: new Date(blockTime * 1000),
  };
}
