// backend/src/services/emergencyExit.service.ts
import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import { getSolPriceUsd, resolveLiquidityUsd } from "./jupiter.service.js";

const LOG = getLogger("emergency-exit");

// A single sell moving this much of the pool's total liquidity in one
// transaction is a real "someone is draining this pool" signal, independent
// of the pool's absolute size (a fixed SOL threshold would miss it on the
// small/thin pools this bot actually targets, and false-trigger on large ones).
const LARGE_SELL_LP_PCT = Number(process.env.LARGE_SELL_LP_PCT ?? 0.3);

// Use Helius RPC for monitoring
const SOLANA_RPC =
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL) ||
  process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
  "https://api.mainnet-beta.solana.com";

const commitment: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) || "confirmed";

const connection = new Connection(SOLANA_RPC, commitment);

interface EmergencyTrigger {
  triggered: boolean;
  reason?: string;
  severity: "critical" | "high" | "medium";
}

/**
 * Check if liquidity pool has been removed or rugged
 * This is the most critical emergency exit trigger
 */
export async function checkLPRemoval(
  tokenMint: string,
  poolAddress?: string,
): Promise<EmergencyTrigger> {
  try {
    if (!poolAddress) {
      // If we don't have pool address, try to detect from token account
      LOG.warn({ tokenMint }, "No pool address provided for LP removal check");
      return { triggered: false, severity: "medium" };
    }

    // Check if pool account still exists
    const poolPubkey = new PublicKey(poolAddress);
    const accountInfo = await connection.getAccountInfo(poolPubkey);

    if (!accountInfo) {
      LOG.error(
        { tokenMint, poolAddress },
        "EMERGENCY: Liquidity pool account not found - LP REMOVED!",
      );
      return {
        triggered: true,
        reason: "Liquidity pool removed (rug pull detected)",
        severity: "critical",
      };
    }

    // Check if pool is closed (lamports = 0)
    if (accountInfo.lamports === 0) {
      LOG.error(
        { tokenMint, poolAddress },
        "EMERGENCY: Liquidity pool closed - LP REMOVED!",
      );
      return {
        triggered: true,
        reason: "Liquidity pool closed (zero lamports)",
        severity: "critical",
      };
    }

    return { triggered: false, severity: "medium" };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error checking LP removal",
    );
    return { triggered: false, severity: "medium" };
  }
}

/**
 * Detect a single transaction moving a large share of the pool's own
 * liquidity — the actual signature of a whale/insider dump, as opposed to
 * an unrelated large SOL transfer that happens to touch the mint.
 */
export async function detectLargeSell(
  tokenMint: string,
  poolAddress?: string,
): Promise<EmergencyTrigger> {
  try {
    if (!poolAddress) {
      return { triggered: false, severity: "high" };
    }

    const tokenPubkey = new PublicKey(tokenMint);

    // Get recent signatures (last 10 transactions)
    const signatures = await connection.getSignaturesForAddress(tokenPubkey, {
      limit: 10,
    });

    if (signatures.length === 0) {
      return { triggered: false, severity: "high" };
    }

    const latestSig = signatures[0];
    if (!latestSig) {
      return { triggered: false, severity: "high" };
    }

    const txDetails = await connection.getTransaction(latestSig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!txDetails) {
      return { triggered: false, severity: "high" };
    }

    // Real per-token liquidity, not a fixed SOL amount — a thin pool can be
    // drained by well under 10 SOL, and a deep one shouldn't flag on 10 SOL
    // moving at all. Derived from a price-impact estimate off a real quote —
    // a trading function, not a Jupiter catalog/metadata fetch.
    const solPriceUsd = await getSolPriceUsd();
    if (!solPriceUsd) {
      return { triggered: false, severity: "high" };
    }
    const { liquidityUSD } = await resolveLiquidityUsd(
      tokenMint,
      0,
      solPriceUsd,
    );
    const poolLiquiditySol = liquidityUSD / solPriceUsd;
    if (!(poolLiquiditySol > 0)) {
      return { triggered: false, severity: "high" };
    }

    const preBalances = txDetails.meta?.preBalances || [];
    const postBalances = txDetails.meta?.postBalances || [];

    for (let i = 0; i < preBalances.length; i++) {
      const preBalance = preBalances[i];
      const postBalance = postBalances[i];
      if (preBalance === undefined || postBalance === undefined) continue;

      const balanceChange = Math.abs(postBalance - preBalance);
      const solChange = balanceChange / 1e9;
      const lpPct = solChange / poolLiquiditySol;

      if (lpPct >= LARGE_SELL_LP_PCT) {
        LOG.warn(
          {
            tokenMint,
            solChange,
            poolLiquiditySol,
            lpPct: (lpPct * 100).toFixed(1),
            signature: latestSig.signature,
          },
          "Large transaction detected relative to pool size - potential dump",
        );
        return {
          triggered: true,
          reason: `Large sell detected (${solChange.toFixed(2)} SOL, ${(
            lpPct * 100
          ).toFixed(0)}% of pool liquidity)`,
          severity: "high",
        };
      }
    }

    return { triggered: false, severity: "high" };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error detecting large sell",
    );
    return { triggered: false, severity: "high" };
  }
}

interface PricePoint {
  price: number;
  timestamp: number;
}

const priceHistory = new Map<string, PricePoint[]>();

/**
 * Detect 60% red candle in 10 seconds
 * Monitors rapid price crash
 */
export async function detectRedCandle(
  tokenMint: string,
  currentPrice: number,
): Promise<EmergencyTrigger> {
  try {
    const now = Date.now();
    const history = priceHistory.get(tokenMint) || [];

    // Add current price point
    history.push({ price: currentPrice, timestamp: now });

    // Keep only last 30 seconds of history
    const recentHistory = history.filter((p) => now - p.timestamp <= 30000);
    priceHistory.set(tokenMint, recentHistory);

    // Check for 60% drop in last 10 seconds
    const tenSecondsAgo = now - 10000;
    const recentPrices = recentHistory.filter(
      (p) => p.timestamp >= tenSecondsAgo,
    );

    if (recentPrices.length < 2) {
      return { triggered: false, severity: "high" };
    }

    const highestRecent = Math.max(...recentPrices.map((p) => p.price));
    const lowestRecent = Math.min(...recentPrices.map((p) => p.price));

    const dropPct = (highestRecent - lowestRecent) / highestRecent;

    if (dropPct >= 0.6) {
      LOG.error(
        {
          tokenMint,
          highestRecent,
          lowestRecent,
          dropPct: (dropPct * 100).toFixed(1),
        },
        "EMERGENCY: 60% red candle detected!",
      );
      return {
        triggered: true,
        reason: `60% price crash in 10 seconds (${(dropPct * 100).toFixed(
          1,
        )}% drop)`,
        severity: "critical",
      };
    }

    return { triggered: false, severity: "high" };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error detecting red candle",
    );
    return { triggered: false, severity: "high" };
  }
}

/**
 * Detect the creator/dev wallet actually reducing its holding of THIS token —
 * not just any recent activity from that wallet, which would false-positive
 * on completely unrelated transactions and miss sells routed through a
 * different signer.
 */
export async function detectCreatorSell(
  tokenMint: string,
  creatorAddress?: string,
): Promise<EmergencyTrigger> {
  try {
    if (!creatorAddress) {
      LOG.debug(
        { tokenMint },
        "No creator address provided for creator sell check",
      );
      return { triggered: false, severity: "high" };
    }

    const creatorPubkey = new PublicKey(creatorAddress);

    const signatures = await connection.getSignaturesForAddress(creatorPubkey, {
      limit: 5,
    });
    if (signatures.length === 0) {
      return { triggered: false, severity: "high" };
    }

    const now = Math.floor(Date.now() / 1000);
    // Only worth parsing transactions from the last 30s — anything older
    // isn't a "just happened" signal worth an emergency reaction.
    const recentSigs = signatures.filter(
      (s) => s.blockTime && now - s.blockTime < 30,
    );
    if (recentSigs.length === 0) {
      return { triggered: false, severity: "high" };
    }

    for (const sigInfo of recentSigs) {
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;

      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];

      for (const postBal of post) {
        if (postBal.mint !== tokenMint || postBal.owner !== creatorAddress) {
          continue;
        }
        const preBal = pre.find(
          (p) =>
            p.mint === tokenMint &&
            p.owner === creatorAddress &&
            p.accountIndex === postBal.accountIndex,
        );
        const preAmount = Number(preBal?.uiTokenAmount.uiAmount ?? 0);
        const postAmount = Number(postBal.uiTokenAmount.uiAmount ?? 0);

        if (postAmount < preAmount) {
          LOG.warn(
            {
              tokenMint,
              creatorAddress,
              preAmount,
              postAmount,
              signature: sigInfo.signature,
            },
            "Creator wallet reduced its holding of this token",
          );
          return {
            triggered: true,
            reason: `Creator sold ${(preAmount - postAmount).toLocaleString()} tokens`,
            severity: "high",
          };
        }
      }
    }

    return { triggered: false, severity: "high" };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error detecting creator sell",
    );
    return { triggered: false, severity: "high" };
  }
}

/**
 * Run all emergency exit checks
 * Returns true if ANY critical trigger is detected
 */
export async function checkAllEmergencyTriggers(
  tokenMint: string,
  currentPrice: number,
  poolAddress?: string,
  creatorAddress?: string,
): Promise<{
  shouldExit: boolean;
  triggers: EmergencyTrigger[];
  criticalReason?: string;
}> {
  try {
    const triggers = await Promise.all([
      checkLPRemoval(tokenMint, poolAddress),
      detectLargeSell(tokenMint, poolAddress),
      detectRedCandle(tokenMint, currentPrice),
      detectCreatorSell(tokenMint, creatorAddress),
    ]);

    // Check for any critical triggers
    const criticalTrigger = triggers.find(
      (t) => t.triggered && t.severity === "critical",
    );

    if (criticalTrigger) {
      return {
        shouldExit: true,
        triggers,
        criticalReason: criticalTrigger.reason || "Critical exit trigger",
      };
    }

    // Check for multiple high-severity triggers
    const highTriggers = triggers.filter(
      (t) => t.triggered && t.severity === "high",
    );

    if (highTriggers.length >= 2) {
      return {
        shouldExit: true,
        triggers,
        criticalReason: `Multiple warning signs: ${highTriggers
          .map((t) => t.reason)
          .join(", ")}`,
      };
    }

    return {
      shouldExit: false,
      triggers,
    };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error checking emergency triggers",
    );
    return {
      shouldExit: false,
      triggers: [],
    };
  }
}
