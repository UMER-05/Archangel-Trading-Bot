// frontend/components/trading/AutoTradeReadiness.tsx
//
// A persistent status indicator for "will the bot actually trade for me
// right now" — distinct from AccountNotifications.tsx's transient popups.
// Whether a wallet is funded above the sizing floor and has auto-trade
// enabled is a continuous state, not a discrete event, so it's shown as an
// always-visible card/pill rather than a toast that would either miss the
// moment or spam on every discovery tick.
//
// "Ready" here mirrors every gate the backend applies before a wallet gets a
// buy (services/multiUserExecution.service.ts + validationPipeline Stage 0):
//   1. auto-trade switched on
//   2. the lifetime Max Total Trades cap hasn't been used up (closed trades
//      count toward it)
//   3. the trading wallet's balance can fund at least one position of the
//      minimum size — the same split the backend uses (lib/positionSizing.ts)
//   4. today's loss hasn't hit the server's daily loss limit
//   5. if a trading budget is on, some of its capital is still free to trade —
//      a budget that is fully AT WORK is fine (a slot reopens when a position
//      closes), but one whose capital has been used up by losses needs raising
// A wallet whose Max Open Positions (or the server's own position cap) are ALL
// in use is still "ready": that's the bot working as configured, and a slot
// reopens when a position closes.
"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useUserWallet } from "@hooks/useUserWallet";
import { useTraderConfig } from "@hooks/useTraderConfig";
import { formatNumber } from "@lib/utils";
import { computePositionSize } from "@lib/positionSizing";
import { Button } from "@components/ui/button";
import { TraderConfigModal } from "@components/trading/trader-config-modal";

interface AutoTradeReadinessProps {
  // Full card (Settings page) vs a single-line pill (trading dashboard
  // header) — same underlying status, different amount of real estate.
  compact?: boolean;
}

// tradesTaken only changes when the bot buys; poll it gently so the cap
// warning appears without a page reload.
const CONFIG_REFRESH_MS = 30_000;

export function AutoTradeReadiness({
  compact = false,
}: AutoTradeReadinessProps) {
  const router = useRouter();
  const { connected } = useSolanaWallet();
  const {
    balanceSol,
    maxOpenPositions: walletMaxOpenPositions,
    openPositions,
    minTradeSol,
    feeReserveSol,
    dailyLossPct,
    maxDailyLossPct,
    serverMaxOpenPositions,
    tradingBudgetSol,
    realizedLossSol,
    deployedSol,
    protectedProfitSol,
    error: walletError,
  } = useUserWallet();
  const { config, loadError, refetch } = useTraderConfig();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => {
      void refetch();
    }, CONFIG_REFRESH_MS);
    return () => clearInterval(id);
  }, [connected, refetch]);

  if (!connected) return null;

  // Anything we couldn't read is UNKNOWN, not "fine" — the old `?? 0`
  // defaults turned a failed fetch into "funded, ready".
  const statusUnknown =
    balanceSol == null ||
    minTradeSol == null ||
    feeReserveSol == null ||
    config == null;

  if (statusUnknown) {
    if (walletError || loadError) {
      const why = walletError || loadError || "";
      return compact ? (
        <span
          title={why}
          className="inline-flex items-center gap-1.5 text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-500/30 rounded-full px-3 py-1"
        >
          <AlertTriangle className="w-3.5 h-3.5" /> Status unavailable
        </span>
      ) : (
        <div className="flex items-start gap-2 text-sm text-yellow-400 bg-yellow-900/20 border border-yellow-500/30 rounded-lg px-4 py-3">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            Couldn&apos;t check whether the bot can trade for you: {why}
          </span>
        </div>
      );
    }
    // No error yet, so this is the first load (or the render just after a
    // wallet connects, before the fetches have started).
    return compact ? null : (
      <div className="flex items-center gap-2 text-sm text-base-content/50 py-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Checking auto-trade
        readiness...
      </div>
    );
  }

  const g = config.globalSettings;
  const autoTradeEnabled = g?.autoTradeEnabled ?? false;

  const maxTotalTrades = g?.maxTotalTrades ?? null;
  const tradesTaken = config.tradesTaken ?? null;
  const capReached =
    maxTotalTrades != null &&
    maxTotalTrades > 0 &&
    tradesTaken != null &&
    tradesTaken >= maxTotalTrades;
  const tradeCountNote =
    maxTotalTrades != null && tradesTaken != null
      ? `${tradesTaken} of ${maxTotalTrades} lifetime trades used.`
      : "";

  // The same sizing rule the backend applies to every buy. A fixed amount
  // overrides the balance/free-slot split; the server's normalized slot
  // count still limits simultaneous positions.
  const maxOpenPositions = walletMaxOpenPositions ?? g?.maxOpenPositions ?? 5;
  const sizing = computePositionSize({
    balanceSol,
    openPositions: openPositions ?? 0,
    maxOpenPositions,
    minTradeSol,
    feeReserveSol,
    budgetSol: tradingBudgetSol,
    deployedSol: deployedSol ?? 0,
    realizedLossSol: realizedLossSol ?? 0,
    fixedTradeAmountSol: g?.fixedTradeAmountSol ?? undefined,
  });
  const lowBalance =
    sizing.status === "low_balance" && sizing.limitedBy === "balance";
  // Budget on and none of its capital free to trade: either it is all at work
  // (normal — a slot reopens when a position closes) or losses have used it up.
  const budgetLimited =
    sizing.status === "low_balance" && sizing.limitedBy === "budget";
  const budgetAtWork = budgetLimited && (deployedSol ?? 0) > 0;
  const budgetExhausted = budgetLimited && !budgetAtWork;
  const atServerCap =
    (serverMaxOpenPositions ?? 0) > 0 &&
    (openPositions ?? 0) >= (serverMaxOpenPositions ?? 0);
  const atCapacity =
    sizing.status === "at_capacity" || atServerCap || budgetAtWork;
  const slotsFull =
    atCapacity && !budgetAtWork
      ? atServerCap
        ? serverMaxOpenPositions
        : maxOpenPositions
      : null;

  // Today's loss against the server's daily limit — the bot pauses NEW buys
  // (it keeps managing open positions) until the day rolls over.
  const dailyLimitReached =
    dailyLossPct != null &&
    maxDailyLossPct != null &&
    dailyLossPct >= maxDailyLossPct;
  // The per-trade size cap no longer applies to auto-buys (a fixed size is
  // the trader's own decision), so it is not a readiness condition here.
  const ready =
    autoTradeEnabled &&
    !capReached &&
    !lowBalance &&
    !budgetExhausted &&
    !dailyLimitReached;

  // Profit the bot is keeping its hands off, when a budget is on.
  const protectedNote =
    tradingBudgetSol !== null && (protectedProfitSol ?? 0) > 0
      ? ` ${formatNumber(protectedProfitSol ?? 0, 4)} SOL of profit is protected — the bot won't trade it, and you can withdraw it.`
      : "";

  if (ready) {
    // The balance may fund fewer positions than the user allows.
    const partialNote =
      sizing.status === "ready" &&
      g?.fixedTradeAmountSol == null &&
      !atServerCap &&
      sizing.slotsUsed < sizing.freeSlots
        ? ` Your balance only funds ${sizing.slotsUsed} of the ${sizing.freeSlots} free slots at the minimum size, so you'll hold fewer than ${maxOpenPositions} positions until you top up.`
        : "";
    const nextNote =
      sizing.status === "ready"
        ? ` Next position ≈ ${formatNumber(sizing.buySol, 4)} SOL.${partialNote}`
        : "";
    const atCapacityText = budgetAtWork
      ? `Auto-trade is on — your whole trading budget is at work. The bot opens a new position as soon as one closes.`
      : `Auto-trade is on — all ${slotsFull} position slots are in use${
          atServerCap ? " (the server's own position cap)" : ""
        }. The bot opens a new position as soon as one closes.`;
    return compact ? (
      <span
        title={
          atCapacity
            ? `${
                budgetAtWork
                  ? "Your trading budget is fully at work"
                  : `All ${slotsFull} position slots are in use`
              } — a new position opens when one closes.${protectedNote}${
                tradeCountNote ? ` ${tradeCountNote}` : ""
              }`
            : `${partialNote}${protectedNote} ${
                tradeCountNote || ""
              }`.trim() || undefined
        }
        className="inline-flex items-center gap-1.5 text-xs text-green-400 bg-green-900/20 border border-green-500/30 rounded-full px-3 py-1"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />{" "}
        {atCapacity ? "Auto-trade on · slots full" : "Auto-trade ready"}
      </span>
    ) : (
      <div className="flex items-center gap-2 text-sm text-green-400 bg-green-900/20 border border-green-500/30 rounded-lg px-4 py-3">
        <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
        {atCapacity
          ? `${atCapacityText}${protectedNote}${
              tradeCountNote ? ` ${tradeCountNote}` : ""
            }`
          : `Auto-trade is on and your wallet is funded — the bot can trade for you.${nextNote}${protectedNote}${
              tradeCountNote ? ` ${tradeCountNote}` : ""
            }`}
      </div>
    );
  }

  // Problems fixed in Trading Settings vs. by depositing SOL.
  const needsSettings = !autoTradeEnabled || capReached || budgetExhausted;

  const missing: string[] = [];
  if (lowBalance) {
    missing.push(
      `top up your trading wallet to at least ${formatNumber(
        sizing.neededSol,
        3
      )} SOL (it has ${formatNumber(balanceSol, 3)} SOL) — a low balance is what stops the bot opening positions`
    );
  }
  if (budgetExhausted) {
    missing.push(
      `raise your trading budget in Trading Settings${
        sizing.status === "low_balance" && sizing.neededBudgetSol != null
          ? ` to at least ${formatNumber(sizing.neededBudgetSol, 3)} SOL`
          : ""
      } — its capital is used up${
        (realizedLossSol ?? 0) > 0
          ? ` (${formatNumber(realizedLossSol ?? 0, 4)} SOL of the ${tradingBudgetSol} SOL budget has been lost)`
          : ""
      }, and the rest of your wallet is protected, so the bot won't touch it`
    );
  }
  if (!autoTradeEnabled) {
    missing.push("enable auto-trade in Trading Settings");
  }
  if (capReached) {
    missing.push(
      `raise Max Total Trades in Trading Settings (${tradesTaken} of ${maxTotalTrades} used — closed trades count too)`
    );
  }
  if (dailyLimitReached) {
    missing.push(
      `wait for tomorrow: today's losses reached the daily loss limit (${formatNumber(
        dailyLossPct ?? 0,
        1
      )}% of ${maxDailyLossPct}%), so the bot has paused new buys — open positions are still managed`
    );
  }
  const reasonText = `The bot won't trade for you yet — ${missing.join(
    " and "
  )}.${tradeCountNote ? ` ${tradeCountNote}` : ""}`;

  // Say WHAT is stopping it right on the pill, not just "not active" — a
  // user who hit their trade limit shouldn't have to hover to find out.
  const pillLabel = !autoTradeEnabled
    ? "Auto-trade is off"
    : capReached
      ? `Trade limit reached (${tradesTaken}/${maxTotalTrades})`
      : budgetExhausted
        ? "Trading budget used up"
        : dailyLimitReached
          ? "Daily loss limit reached"
          : lowBalance
            ? "Low balance"
            : "Auto-trade not active";

  if (compact) {
    return (
      // The modal is a SIBLING of the pill. It used to be rendered inside the
      // <button>, so a click on the modal's Cancel/Save bubbled to the pill's
      // onClick and reopened it — it could never be closed.
      <>
        <button
          onClick={() =>
            needsSettings ? setSettingsOpen(true) : router.push("/settings")
          }
          title={reasonText}
          className="inline-flex items-center gap-1.5 text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-500/30 rounded-full px-3 py-1 hover:bg-yellow-900/30 transition-colors"
        >
          <AlertTriangle className="w-3.5 h-3.5" /> {pillLabel}
        </button>
        {settingsOpen && (
          <TraderConfigModal
            isOpen={settingsOpen}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 flex-wrap text-sm text-yellow-400 bg-yellow-900/20 border border-yellow-500/30 rounded-lg px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>{reasonText}</span>
      </div>
      {needsSettings && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSettingsOpen(true)}
        >
          Open Trading Settings
        </Button>
      )}
      {settingsOpen && (
        <TraderConfigModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export default AutoTradeReadiness;
