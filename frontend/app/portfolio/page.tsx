"use client";

import React from "react";
import { motion } from "framer-motion";
import TradeSummary from "@components/trading/trade-summary";
import PortfolioPnLPanel from "@components/trading/PortfolioPnLPanel";
import PositionsPanel from "@components/trading/PositionsPanel";
import TradeHistory from "@components/trading/trade-history";
import { useStatsSync } from "@hooks/useStatsSync";

// Content must never depend on this animation actually running to become
// visible — opacity starts at 1 so a stalled/skipped animation (reduced
// motion, a slow device, rAF throttling) just means no slide-in, not a
// blank section.
const fadeIn = (delay = 0) => ({
  initial: { opacity: 1, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay },
});

export default function PortfolioPage() {
  // Same bootstrapping as /trading — this page can be the first one a user
  // lands on, so it can't rely on /trading having already populated the
  // shared stats store.
  useStatsSync();

  return (
    <div className="space-y-10">
      <motion.div {...fadeIn(0.1)}>
        <div className="kicker mb-1">Performance</div>
        <h1 className="text-3xl font-bold text-white mb-1">Portfolio</h1>
        <p className="text-base-content/50 text-sm">
          Real, trade-based performance — positions, P&amp;L, and history.
        </p>
      </motion.div>

      <motion.div {...fadeIn(0.15)}>
        <TradeSummary />
      </motion.div>

      <motion.div {...fadeIn(0.2)}>
        <PortfolioPnLPanel />
      </motion.div>

      <motion.div {...fadeIn(0.25)}>
        <PositionsPanel />
      </motion.div>

      <motion.div {...fadeIn(0.3)}>
        <TradeHistory />
      </motion.div>
    </div>
  );
}
