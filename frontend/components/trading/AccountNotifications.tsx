// components/trading/AccountNotifications.tsx
//
// Pop-up feed of "what just happened on your account" — every socket event
// here is already scoped to the connected wallet's own room by the backend
// (see walletSocket.ts's emitToWalletOrGlobal), so whatever arrives through
// lastMessage is safe to show as-is; nothing here re-filters by wallet.
// Covers both outcomes: successful auto-buys/sells/deposits (green) and the
// reasons a trade was skipped or force-exited (yellow/red) — previously only
// true emergencies surfaced here, so a skipped buy or a landed deposit gave
// no signal at all.
"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, XCircle, Info, CheckCircle2 } from "lucide-react";
import { useSocket } from "@hooks/useSocket";
import { useSocketEvent } from "@hooks/useSocketEvent";

interface Alert {
  id: string;
  type: "emergency" | "error" | "warning" | "success";
  message: string;
  timestamp: number;
}

// The backend reports why a wallet's buy didn't go through as
// "candidate:buy_failed" (wallet-scoped). The same reason repeats for every
// candidate while the cause persists (e.g. "balance too low"), so show each
// distinct reason at most once a minute instead of a popup per token.
const BUY_FAILED_DEDUPE_MS = 60_000;
const MAX_STACKED_ALERTS = 5;

interface BuyFailedPayload {
  mint?: string;
  failedStageName?: string;
  reason?: string;
}

export const AccountNotifications: React.FC = () => {
  const { lastMessage } = useSocket();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const lastBuyFailedAt = useRef<Map<string, number>>(new Map());

  // Subscribed directly rather than through lastMessage: that slot only
  // holds the latest event and never carried candidate:* events at all, so
  // these reasons were never shown.
  useSocketEvent<BuyFailedPayload>("candidate:buy_failed", (payload) => {
    const stage = payload?.failedStageName || "validation";
    const reason = payload?.reason || "condition not met";
    const key = `${stage}|${reason}`;
    const now = Date.now();

    const last = lastBuyFailedAt.current.get(key);
    if (last !== undefined && now - last < BUY_FAILED_DEDUPE_MS) return;
    lastBuyFailedAt.current.set(key, now);
    if (lastBuyFailedAt.current.size > 50) {
      const oldest = lastBuyFailedAt.current.keys().next().value;
      if (oldest !== undefined) lastBuyFailedAt.current.delete(oldest);
    }

    setAlerts((prev) =>
      [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "warning" as const,
          message: `⏭️ Auto-buy skipped: ${stage} — ${reason}`,
          timestamp: now,
        },
      ].slice(-MAX_STACKED_ALERTS)
    );
  });

  useEffect(() => {
    if (!lastMessage) return;

    const { event, payload } = lastMessage;

    // Emergency exits
    if (event === "tradeFeed" && payload?.emergency) {
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "emergency",
          message: `🚨 EMERGENCY EXIT: ${
            payload.exitReason || "Critical trigger"
          } - Token: ${payload.token}`,
          timestamp: Date.now(),
        },
      ]);
    }

    // Ordinary completed buys/sells — auto-trade or a force-sell; manual
    // buy/sell already gets its own toast synchronously from useTrade.ts, so
    // skip those here to avoid a duplicate popup for the same action.
    if (
      event === "tradeFeed" &&
      !payload?.emergency &&
      payload?.auto &&
      (payload?.type === "buy" || payload?.type === "sell")
    ) {
      const pnlSuffix =
        typeof payload.pnl === "number"
          ? ` (${payload.pnl >= 0 ? "+" : ""}${(payload.pnl * 100).toFixed(1)}%)`
          : "";
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "success",
          message: `✅ Bot ${payload.type === "buy" ? "bought" : "sold"} ${
            payload.token
          }${pnlSuffix}`,
          timestamp: Date.now(),
        },
      ]);
    }

    // Deposit landed in the custodial wallet
    if (event === "walletDeposit") {
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "success",
          message: payload?.message || "Deposit received",
          timestamp: Date.now(),
        },
      ]);
    }

    // Jupiter-pipeline auto-buy attempts that reached this wallet's own
    // eligibility check but failed there (balance too low, risk limit,
    // routing/authority/market-health checks) — the jupiterDiscovery.service.ts
    // path's equivalent of the autoBuyer.service.ts "tradeError" events above.
    if (event === "jupiter:pipeline_failed") {
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "warning",
          message: `⏭️ Auto-buy skipped: ${
            payload?.failedStageName || "validation"
          } — ${payload?.reason || "condition not met"}`,
          timestamp: Date.now(),
        },
      ]);
    }

    // Trade errors — reasons a buy was skipped or force-exited for this wallet
    if (event === "tradeError") {
      const launchMetrics = payload?.launchMetrics;
      const limits = payload?.limits;
      const message =
        payload?.type === "launch_metrics_out_of_range" &&
        launchMetrics &&
        limits
          ? `Launch limits rejected token: MC ${Number(
              launchMetrics.marketCapSOL
            ).toFixed(2)} SOL / $${Number(launchMetrics.marketCapUSD).toFixed(
              0
            )}, liquidity ${Number(launchMetrics.liquiditySOL).toFixed(
              2
            )} SOL / $${Number(launchMetrics.liquidityUSD).toFixed(0)}`
          : payload?.reason || payload?.message || "Trade error occurred";
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type:
            payload.type === "test_sell_failed_emergency_exit"
              ? "emergency"
              : "error",
          message,
          timestamp: Date.now(),
        },
      ]);
    }

    // Position trailing updates (warning level)
    if (event === "position:trailingUpdate" && payload?.trailingActivated) {
      setAlerts((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "warning",
          message: `📉 Trailing Stop Active: ${payload.token} (Peak: +${(
            payload.highestPnlPct * 100
          ).toFixed(1)}%)`,
          timestamp: Date.now(),
        },
      ]);
    }
  }, [lastMessage]);

  // Auto-dismiss alerts after 10 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setAlerts((prev) =>
        prev.filter((alert) => now - alert.timestamp < 10000)
      );
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const dismissAlert = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-md">
      <AnimatePresence>
        {alerts.map((alert) => (
          <motion.div
            key={alert.id}
            // opacity starts at 1 (unlike a typical enter animation) — this
            // is a safety-critical alert, it must never be able to render
            // invisible if the enter transition stalls for any reason.
            initial={{ opacity: 1, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.9 }}
            transition={{ duration: 0.3 }}
            className={`rounded-lg shadow-lg p-4 border-2 ${
              alert.type === "emergency"
                ? "bg-red-900/90 border-red-500 text-red-100"
                : alert.type === "error"
                  ? "bg-orange-900/90 border-orange-500 text-orange-100"
                  : alert.type === "success"
                    ? "bg-green-900/90 border-green-500 text-green-100"
                    : "bg-yellow-900/90 border-yellow-500 text-yellow-100"
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                {alert.type === "emergency" ? (
                  <XCircle size={20} />
                ) : alert.type === "error" ? (
                  <AlertTriangle size={20} />
                ) : alert.type === "success" ? (
                  <CheckCircle2 size={20} />
                ) : (
                  <Info size={20} />
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold">{alert.message}</p>
                <p className="text-xs opacity-70 mt-1">
                  {new Date(alert.timestamp).toLocaleTimeString()}
                </p>
              </div>
              <button
                onClick={() => dismissAlert(alert.id)}
                className="flex-shrink-0 opacity-70 hover:opacity-100 transition"
              >
                <XCircle size={16} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};

export default AccountNotifications;
