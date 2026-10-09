// components/trading/TrancheProgress.tsx
"use client";

import React from "react";
import { motion } from "framer-motion";
import { TrendingDown } from "lucide-react";

// Profit tiers the monitor can scale out at, in percent. The monitor only
// applies a tier BELOW the position's take profit (at or above it the take
// profit has already closed the whole position), so a tier is shown only
// when this position's take profit is higher.
const PROFIT_TIERS = [
  { level: 40, label: "Tier 1", key: "soldAt40" },
  { level: 80, label: "Tier 2", key: "soldAt80" },
  { level: 150, label: "Tier 3", key: "soldAt150" },
] as const;

interface TrancheProgressProps {
  token: string;
  // Timestamp of the (single) buy that opened this position. The bot buys a
  // position in one go; secondTrancheEntry is legacy and never set.
  firstTrancheEntry?: number;
  secondTrancheEntry?: number;
  remainingPct?: number;
  soldAt40?: boolean;
  soldAt80?: boolean;
  soldAt150?: boolean;
  currentPnl?: number;
  trailingActivated?: boolean;
  highestPnlPct?: number;
  // This position's own exit levels, as decimals (0.1 = +10%).
  tpPct?: number;
  slPct?: number;
}

export const TrancheProgress: React.FC<TrancheProgressProps> = ({
  token,
  firstTrancheEntry,
  remainingPct = 100,
  soldAt40,
  soldAt80,
  soldAt150,
  currentPnl = 0,
  trailingActivated,
  highestPnlPct,
  tpPct,
  slPct,
}) => {
  const profitPct = currentPnl * 100;
  const sold = { soldAt40, soldAt80, soldAt150 };

  // Only tiers that sit below this position's take profit can ever fire.
  const tiers =
    typeof tpPct === "number"
      ? PROFIT_TIERS.filter((tier) => tier.level / 100 < tpPct)
      : [];
  const nextTier = tiers.find((tier) => !sold[tier.key]) ?? null;
  const progressToNextTier = nextTier
    ? Math.min((profitPct / nextTier.level) * 100, 100)
    : 100;

  return (
    <div className="bg-base-300 rounded-lg p-3 space-y-3">
      {/* Entry */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-400">Entered</div>
        <div className="text-xs text-slate-300">
          {firstTrancheEntry
            ? new Date(firstTrancheEntry).toLocaleString()
            : "—"}
        </div>
      </div>

      {/* Exit levels */}
      {(typeof tpPct === "number" || typeof slPct === "number") && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-400">Exit levels</span>
          <span>
            {typeof tpPct === "number" && (
              <span className="text-green-400">
                Take profit +{Number((tpPct * 100).toFixed(2))}%
              </span>
            )}
            {typeof tpPct === "number" && typeof slPct === "number" && (
              <span className="text-slate-600"> · </span>
            )}
            {typeof slPct === "number" && (
              <span className="text-red-400">
                Stop loss −{Number((slPct * 100).toFixed(2))}%
              </span>
            )}
          </span>
        </div>
      )}

      {/* Position Remaining */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-400">
          Position Size
        </div>
        <div className="text-sm font-bold">
          <span
            className={
              remainingPct === 100
                ? "text-white"
                : remainingPct >= 40
                  ? "text-blue-400"
                  : remainingPct > 0
                    ? "text-yellow-400"
                    : "text-slate-500"
            }
          >
            {remainingPct}%
          </span>
        </div>
      </div>

      {/* Profit Tiers — only the ones this take profit leaves room for */}
      {remainingPct > 0 && tiers.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Profit Tiers</span>
            {nextTier && (
              <span className="text-slate-300">
                Next: {nextTier.label} (+{nextTier.level}%)
              </span>
            )}
          </div>

          {/* Tier Progress Bar */}
          {nextTier && (
            <div className="relative h-2 bg-base-100 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: "0%" }}
                animate={{ width: `${progressToNextTier}%` }}
                transition={{ duration: 0.5 }}
                className={`h-full ${
                  profitPct >= nextTier.level
                    ? "bg-green-500"
                    : profitPct >= 0
                      ? "bg-blue-500"
                      : "bg-red-500"
                }`}
              />
            </div>
          )}

          {/* Tier Badges */}
          <div className="flex gap-2">
            {tiers.map((tier) => (
              <div
                key={tier.key}
                className={`text-xs px-2 py-1 rounded ${
                  sold[tier.key]
                    ? "bg-green-900/50 text-green-300"
                    : "bg-slate-800/50 text-slate-500"
                }`}
              >
                {tier.label}: +{tier.level}%
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trailing Stop Indicator */}
      {trailingActivated && remainingPct <= 10 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-blue-900/30 border border-blue-500/50 rounded p-2"
        >
          <div className="flex items-center gap-2 text-xs">
            <TrendingDown size={14} className="text-blue-400" />
            <span className="text-blue-300 font-semibold">
              Trailing Stop Active (Final 10%)
            </span>
          </div>
          {highestPnlPct !== undefined && (
            <div className="text-xs text-slate-400 mt-1">
              Peak: +{(highestPnlPct * 100).toFixed(1)}% | Current: +
              {profitPct.toFixed(1)}%
            </div>
          )}
        </motion.div>
      )}

      {/* Fully Exited */}
      {remainingPct === 0 && (
        <div className="text-center text-xs text-slate-500 py-2">
          Position Fully Exited
        </div>
      )}
    </div>
  );
};
