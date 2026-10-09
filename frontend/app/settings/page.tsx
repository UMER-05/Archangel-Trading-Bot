"use client";

import React from "react";
import { motion } from "framer-motion";
import { DepositPanel } from "@components/trading/DepositPanel";
import { AutoTradeReadiness } from "@components/trading/AutoTradeReadiness";

// Content must never depend on this animation actually running to become
// visible — opacity starts at 1 so a stalled/skipped animation (reduced
// motion, a slow device, rAF throttling) just means no slide-in, not a
// blank section.
const fadeIn = (delay = 0) => ({
  initial: { opacity: 1, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay },
});

export default function SettingsPage() {
  return (
    <div className="space-y-10 max-w-2xl mx-auto">
      <motion.div {...fadeIn(0.1)}>
        <div className="kicker mb-1">Configuration</div>
        <h1 className="text-3xl font-bold text-white mb-1">Settings</h1>
        <p className="text-base-content/50 text-sm">
          Deposit funds and check auto-trade readiness here; how many positions
          the bot may hold at once, your exit levels and the auto-trade switch
          live on the Trading dashboard.
        </p>
      </motion.div>

      <motion.div {...fadeIn(0.2)}>
        <DepositPanel />
      </motion.div>

      <motion.div {...fadeIn(0.22)}>
        <AutoTradeReadiness />
      </motion.div>
    </div>
  );
}
