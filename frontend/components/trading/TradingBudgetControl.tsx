// frontend/components/trading/TradingBudgetControl.tsx
"use client";

import React from "react";
import { Shield } from "lucide-react";

// The "Only trade the SOL I put in" control, shared by the Risk Management
// card and the Trading Settings dialog so both edit the budget the same way.
//
// With the budget ON the bot may only have this much SOL at work; everything
// else in the trading wallet — profits from closed positions, later deposits —
// is PROTECTED: the bot never trades it, and it can be withdrawn at any time.
// The budget's capital shrinks when a position loses but never grows when one
// wins, so a losing streak can't quietly spend profits already made.

interface TradingBudgetControlProps {
  enabled: boolean;
  amount: number | "";
  onChange: (next: { enabled: boolean; amount: number | "" }) => void;
  error?: string | undefined;
  // The saved state, for the read-out (all null while loading / when the
  // budget isn't saved yet).
  balanceSol: number | null;
  maxOpenPositions: number;
  fixedTradeAmountSol?: number | null;
  savedBudgetSol: number | null;
  capitalSol: number | null;
  realizedLossSol: number | null;
  deployedSol: number | null;
  protectedProfitSol: number | null;
}

const fmt = (n: number) => Number(n.toFixed(4));

export const TradingBudgetControl: React.FC<TradingBudgetControlProps> = ({
  enabled,
  amount,
  onChange,
  error,
  balanceSol,
  maxOpenPositions,
  fixedTradeAmountSol,
  savedBudgetSol,
  capitalSol,
  realizedLossSol,
  deployedSol,
  protectedProfitSol,
}) => {
  const perPosition =
    fixedTradeAmountSol != null
      ? fixedTradeAmountSol
      : enabled && amount !== "" && Number(amount) > 0 && maxOpenPositions > 0
        ? Number(amount) / maxOpenPositions
        : null;
  // The read-out describes what is SAVED, so hide it while the user is typing
  // a different number that hasn't been saved yet.
  const showSaved =
    enabled && savedBudgetSol !== null && Number(amount) === savedBudgetSol;

  return (
    <div className="p-2.5 bg-base-300 rounded-lg space-y-2 border border-primary/20">
      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <span className="flex items-center gap-2 text-sm text-gray-200">
          <Shield className="w-4 h-4 text-green-400" />
          Only trade the SOL I put in (protect my profits)
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            onChange({
              enabled: e.target.checked,
              // Turning it on starts from what the trading wallet holds now
              // (rounded down) — one click protects everything above it.
              amount:
                e.target.checked && amount === "" && balanceSol != null
                  ? Math.max(0, Math.floor(balanceSol * 1000) / 1000)
                  : amount,
            })
          }
          className="w-4 h-4 rounded border-gray-700 bg-gray-800 text-green-500"
        />
      </label>

      {!enabled ? (
        <p className="text-xs text-gray-500">
          Off: the bot may use the whole trading wallet — profits from closed
          positions included.
        </p>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-0.5 block">
                Trading budget (SOL the bot may use)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) =>
                  onChange({
                    enabled: true,
                    amount: e.target.value === "" ? "" : Number(e.target.value),
                  })
                }
                className="w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="e.g. 1"
              />
            </div>
            {balanceSol != null && (
              <button
                type="button"
                onClick={() =>
                  onChange({
                    enabled: true,
                    amount: Math.max(0, Math.floor(balanceSol * 1000) / 1000),
                  })
                }
                className="text-xs px-2 py-1.5 rounded border border-base-content/20 text-gray-300 hover:border-primary hover:text-primary transition whitespace-nowrap"
                title="Set the budget to what the trading wallet holds now"
              >
                Use current balance
              </button>
            )}
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          {perPosition !== null && !error && (
            <p className="text-xs text-green-400">
              {fixedTradeAmountSol != null
                ? `Each buy uses the fixed ${fmt(perPosition)} SOL amount; it is skipped if the available budget cannot cover it.`
                : `Each position ≈ ${fmt(perPosition)} SOL (budget ÷ ${maxOpenPositions} Max Open Positions).`}
            </p>
          )}

          {showSaved && (
            <div className="text-xs text-gray-400 space-y-0.5">
              <div>
                At work now:{" "}
                <span className="text-gray-200">
                  {deployedSol != null ? fmt(deployedSol) : "—"} SOL
                </span>
                {realizedLossSol != null && realizedLossSol > 0 && (
                  <>
                    {" "}
                    · Lost since set:{" "}
                    <span className="text-red-400">
                      {fmt(realizedLossSol)} SOL
                    </span>{" "}
                    (capital now {capitalSol != null ? fmt(capitalSol) : "—"}{" "}
                    SOL)
                  </>
                )}
              </div>
              <div>
                Protected profit:{" "}
                <span className="text-green-400">
                  {protectedProfitSol != null ? fmt(protectedProfitSol) : "—"}{" "}
                  SOL
                </span>{" "}
                — never traded; withdraw it any time from the Deposit panel.
              </div>
            </div>
          )}

          <p className="text-[11px] leading-snug text-gray-500">
            Profits never raise the budget, but losses lower it. SOL you deposit
            later stays untouched until you raise the budget. Changing the
            amount starts a fresh tally.
          </p>
        </>
      )}
    </div>
  );
};

export default TradingBudgetControl;
