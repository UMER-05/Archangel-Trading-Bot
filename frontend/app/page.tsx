"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Zap } from "lucide-react";
import { Button } from "@components/ui/button";
import { useSocket } from "@hooks/useSocket";
import { useWallet } from "@hooks/useWallet";
import toast from "react-hot-toast";
import TokenDiscovery from "@components/trading/TokenDiscovery";
import LiveTrades from "@components/trading/LiveTrades";
import PositionsPanel from "@components/trading/PositionsPanel";
import TradeSummary from "@components/trading/trade-summary";
import { useStatsSync } from "@hooks/useStatsSync";

import { WalletBalance } from "@components/ui";

// Content must never depend on this animation actually running to become
// visible — opacity starts at 1 so a stalled/skipped animation (reduced
// motion, a slow device, rAF throttling) just means no slide-in, not a
// blank section.
const fadeIn = (delay = 0) => ({
  initial: { opacity: 1, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45, delay },
});

export default function TradingPage() {
  // Auto-sync stats from backend
  useStatsSync();

  const router = useRouter();
  const { connected } = useWallet();
  const { connected: socketConnected, lastMessage } = useSocket();

  // Toast notification on every trade — the full log lives in LiveTrades below.
  useEffect(() => {
    if (lastMessage?.event !== "tradeFeed") return;

    const trade = lastMessage.payload;
    // The bot's own trades already get their own popup from
    // AccountNotifications; announcing them here as well showed every auto
    // trade twice. This toast is for manual trades.
    if (trade.auto) return;
    // trade.amount is lamports (tradeFeed's convention everywhere it's emitted)
    const amountSol = (trade.amount ?? 0) / 1e9;
    const token = trade.token
      ? `${trade.token.slice(0, 4)}…${trade.token.slice(-4)}`
      : "token";
    toast.success(
      `${String(trade.type).toUpperCase()} ${amountSol.toFixed(4)} SOL of ${token} confirmed`,
      { duration: 3000 }
    );
  }, [lastMessage]);

  return (
    <div className="space-y-8">
      {/* ========================== HEADER ========================== */}
      <motion.div
        {...fadeIn(0)}
        className="flex flex-wrap items-center justify-between gap-4"
      >
        <div>
          <div className="kicker mb-1">Live Dashboard</div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-2.5">
            <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/15 text-primary">
              <Zap size={18} />
            </span>
            Trading Panel
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <WalletBalance />
          <span
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border ${
              socketConnected
                ? "text-success border-success/25 bg-success/10"
                : "text-danger border-danger/25 bg-danger/10"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                socketConnected ? "bg-success animate-pulse" : "bg-danger"
              }`}
            />
            {socketConnected ? "Live" : "Offline"}
          </span>
        </div>
      </motion.div>

      {/* ========================== QUICK TRADE ========================== */}
      <motion.div
        {...fadeIn(0.05)}
        className="grid grid-cols-1 sm:grid-cols-2 gap-4"
      >
        <Button
          variant="secondary"
          onClick={() => {
            if (!connected) {
              toast.error("Please connect your wallet first!");
              return;
            }
            router.push("/trading/buy");
          }}
          disabled={!connected}
          title={connected ? undefined : "Connect your wallet first"}
          className="text-base py-4 hover:shadow-glow-success"
        >
          <TrendingUp size={18} className="text-success" />
          Buy a Token
        </Button>

        <Button
          variant="secondary"
          onClick={() => {
            if (!connected) {
              toast.error("Please connect your wallet first!");
              return;
            }
            router.push("/trading/sell");
          }}
          disabled={!connected}
          title={connected ? undefined : "Connect your wallet first"}
          className="text-base py-4"
        >
          <TrendingDown size={18} className="text-danger" />
          Sell a Token
        </Button>
      </motion.div>

      {/* ========================== STATS ========================== */}
      <motion.div {...fadeIn(0.1)}>
        <TradeSummary />
      </motion.div>

      {/* ========================== MAIN GRID ========================== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div {...fadeIn(0.15)} className="lg:col-span-2 space-y-6">
          <TokenDiscovery />
          <PositionsPanel />
        </motion.div>

        <motion.div {...fadeIn(0.2)}>
          <LiveTrades />
        </motion.div>
      </div>
    </div>
  );
}
