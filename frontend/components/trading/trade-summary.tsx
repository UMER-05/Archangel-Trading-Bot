"use client";

import React from "react";
import { motion } from "framer-motion";
import CountUp from "react-countup";
import { TrendingUp, TrendingDown, Briefcase, Wallet } from "lucide-react";
import { Card } from "@components/ui/card";
import { useStats } from "@hooks/useStats";
import { useWallet } from "@hooks/useWallet";

// Round to what the card displays before handing it to CountUp. The backend
// values carry many more decimals (live token prices), so without this every
// 10s refresh changed `end` in an invisible digit and CountUp replayed its
// whole animation even though the shown number stayed the same.
const toDisplay = (value: number | undefined, decimals = 4): number => {
  const n = Number(value) || 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

export default function TradeSummary() {
  const { stats, loading } = useStats();
  const { connected, balance } = useWallet();

  const profitPositive = stats.totalProfitSol >= 0;

  return (
    <motion.div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6"
      initial={{ opacity: 1, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
    >
      {/* Portfolio Value — total ever deposited into your trading wallet
          plus net PnL (realized + unrealized). Not the same as Wallet
          Balance below. */}
      <Card className="bg-base-200 border p-4 text-center">
        <div className="flex justify-center items-center gap-2">
          <Briefcase size={20} className="text-primary" />
          <h3 className="text-sm font-semibold uppercase">Portfolio Value</h3>
        </div>

        <p className="text-2xl font-bold text-white">
          <CountUp
            end={toDisplay(stats.portfolioValue)}
            preserveValue
            duration={1.4}
            separator=","
            decimals={4}
          />{" "}
          SOL
        </p>
      </Card>

      {/* Wallet Balance — your CONNECTED wallet's own SOL balance, not the
          custodial trading wallet's. Separate from Portfolio Value on
          purpose: this is what you have available to deposit, not your
          trading equity. */}
      <Card className="bg-base-200 border p-4 text-center">
        <div className="flex justify-center items-center gap-2">
          <Wallet size={20} className="text-secondary" />
          <h3 className="text-sm font-semibold uppercase">Wallet Balance</h3>
        </div>

        <p className="text-2xl font-bold text-white">
          {connected ? (
            <CountUp
              end={toDisplay(balance)}
              preserveValue
              duration={1.4}
              separator=","
              decimals={4}
            />
          ) : (
            "—"
          )}{" "}
          SOL
        </p>
      </Card>

      {/* Total Profit */}
      <Card
        className={`border p-4 text-center ${
          profitPositive
            ? "bg-green-950/30 border-green-700/40"
            : "bg-red-950/30 border-red-700/40"
        }`}
      >
        <div className="flex justify-center items-center gap-2">
          {profitPositive ? (
            <TrendingUp size={20} className="text-green-400" />
          ) : (
            <TrendingDown size={20} className="text-red-400" />
          )}
          <h3 className="text-sm font-semibold uppercase">Total Profit</h3>
        </div>

        <p
          className={`text-2xl font-bold ${
            profitPositive ? "text-green-400" : "text-red-400"
          }`}
        >
          <CountUp
            end={toDisplay(stats.totalProfitSol)}
            preserveValue
            duration={1.4}
            separator=","
            decimals={4}
          />{" "}
          SOL
        </p>
      </Card>

      {/* Open Trades */}
      <Card className="bg-base-200 border p-4 text-center">
        <div className="flex justify-center items-center gap-2">
          <TrendingUp size={20} className="text-info" />
          <h3 className="text-sm font-semibold uppercase">Open Trades</h3>
        </div>

        <p className="text-2xl font-bold text-white">
          <CountUp end={stats.openTrades || 0} preserveValue duration={1.4} />
        </p>
      </Card>
    </motion.div>
  );
}
