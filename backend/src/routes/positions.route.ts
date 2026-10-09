import { Router } from "express";
import dbService from "../services/db.service.js";
import { getQuoteImpliedPriceSol } from "../services/jupiter.service.js";
import { getOnChainMintSupply } from "../services/tokenSafetyChecks.service.js";
import { getLogger } from "../utils/logger.js";
import { isOpenPosition } from "../utils/positionState.js";

const router = Router();
const log = getLogger("positions.route");

router.get("/", async (req, res) => {
  try {
    const wallet = req.query.wallet as string | undefined;
    // No wallet query param (no wallet connected on the frontend) means
    // there's no specific identity to show positions for — not even the
    // operator's own, which is that wallet's own private activity now, only
    // visible when it's the one actually connected. Returning early here
    // (rather than falling through to dbService.getPositions(undefined),
    // which means "no restriction" for trusted internal engine callers)
    // avoids handing every wallet's private positions to an unauthenticated
    // request.
    if (!wallet) {
      return res.json({ success: true, positions: [] });
    }
    // Open positions only. This used to return every position ever held —
    // including ones sold long ago — and did a supply lookup plus a Jupiter
    // quote for EACH of them on every dashboard refresh (a steady source of
    // rate-limit errors), then showed them as rows.
    const positions = (await dbService.getPositions(wallet)).filter((p) =>
      isOpenPosition(p),
    );
    if (!positions.length) {
      return res.json({ success: true, positions: [] });
    }

    const enriched = await Promise.all(
      positions.map(async (p) => {
        let currentPrice = 0; // SOL-denominated, same unit as avgBuyPrice
        try {
          // Fair-value price from a small reference Jupiter quote — see
          // getQuoteImpliedPriceSol's own doc comment for the tradeoff.
          // Birdeye has been removed from this codebase entirely; this is
          // the only price source left for display purposes.
          const supplyInfo = await getOnChainMintSupply(p.token);
          if (supplyInfo.available) {
            currentPrice =
              (await getQuoteImpliedPriceSol(p.token, supplyInfo.decimals)) ??
              0;
          }
        } catch (err: any) {
          log.warn(
            { token: p.token.slice(0, 8), err: err?.message },
            "Failed to fetch live price for position",
          );
        }

        const hasPrice = !!p.avgBuyPrice && currentPrice > 0;
        const unrealizedPnlSol = hasPrice
          ? (currentPrice - p.avgBuyPrice!) * (p.netSol / p.avgBuyPrice!)
          : 0;
        // Decimal fraction (0.05 = +5%), matching this codebase's convention
        // elsewhere (TradeRecord.pnl, SL_PCT, tier profit percentages) — the
        // frontend multiplies by 100 for display.
        const unrealizedPnlPct = hasPrice
          ? (currentPrice - p.avgBuyPrice!) / p.avgBuyPrice!
          : 0;

        return {
          ...p,
          currentPrice,
          unrealizedPnlSol,
          unrealizedPnlPct,
        };
      }),
    );

    res.json({
      success: true,
      positions: enriched,
    });
  } catch (err: any) {
    log.error({ err: err?.message }, "Positions API error");
    res.status(500).json({
      success: false,
      message: err.message || "Failed fetching positions",
    });
  }
});

export default router;
