"use client";

import React, { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@components/ui/card";
import { Switch } from "@components/ui/switch";
import { Button } from "@components/ui/button";
import { toast } from "react-hot-toast";
import { useTraderConfig } from "@hooks/useTraderConfig";
import { useSolPrice } from "@hooks/useSolPrice";
import { useUserWallet } from "@hooks/useUserWallet";
import { computePositionSize, describeSizing } from "@lib/positionSizing";
import { TradingBudgetControl } from "@components/trading/TradingBudgetControl";
import {
  DEFAULT_GLOBAL_SETTINGS_FORM,
  formFromSettings,
  hasErrors,
  launchAgeWarning,
  stopLossWarning,
  EXIT_FILL_NOTE,
  toSettingsPayload,
  validateGlobalSettings,
  type GlobalSettingsForm,
} from "@lib/globalSettings";
import { TrendingUp, AlertTriangle, Shield } from "lucide-react";

const INPUT_CLASS =
  "w-full px-2 py-1 bg-base-100 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary";

export const RiskManagementPanel: React.FC = () => {
  // Global, per-wallet auto-trade rules — the real settings the bot's
  // execution engine reads (see multiUserExecution.service.ts).
  const { config, updateGlobalSettings, loading, loadError, refetch } =
    useTraderConfig();
  // The bot trades from this custodial wallet, NOT the wallet connected to
  // the dashboard — so its balance is the one that decides what a buy looks
  // like. (The panel used to use the connected wallet's balance here.)
  const {
    balanceSol,
    openPositions,
    minTradeSol,
    feeReserveSol,
    tradingBudgetSol: savedBudget,
    tradingCapitalSol,
    realizedLossSol,
    deployedSol,
    protectedProfitSol,
  } = useUserWallet();
  const solPriceUsd = useSolPrice();

  const [formData, setFormData] = useState<GlobalSettingsForm>(
    DEFAULT_GLOBAL_SETTINGS_FORM
  );
  const [saving, setSaving] = useState(false);
  // True once the user has touched a field, so a config broadcast doesn't
  // overwrite what they're typing.
  const dirty = useRef(false);

  // Whether the form has been filled from the saved settings yet. Until it
  // has, incoming settings always win: anything typed before they arrived was
  // typed over defaults, and saving that would overwrite the real settings.
  const hydrated = useRef(false);

  useEffect(() => {
    if (!config?.globalSettings) {
      hydrated.current = false; // wallet switched / not loaded
      return;
    }
    if (!hydrated.current || !dirty.current) {
      setFormData(formFromSettings(config.globalSettings));
      hydrated.current = true;
      dirty.current = false;
    }
  }, [config]);

  const setField = <K extends keyof GlobalSettingsForm>(
    key: K,
    value: GlobalSettingsForm[K]
  ) => {
    dirty.current = true;
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const errors = validateGlobalSettings(formData);
  const launchWarning = launchAgeWarning(formData);
  const slWarning = stopLossWarning(formData);
  const loaded = config != null;

  // The budget as currently typed (null when off or not a usable number).
  const budgetForPreview =
    formData.budgetEnabled &&
    formData.tradingBudgetSol !== "" &&
    Number(formData.tradingBudgetSol) > 0
      ? Number(formData.tradingBudgetSol)
      : null;

  // What the split means for the wallet as it is right now.
  const sizing =
    !errors.maxOpenPositions &&
    balanceSol != null &&
    minTradeSol != null &&
    feeReserveSol != null
      ? computePositionSize({
          balanceSol,
          openPositions: openPositions ?? 0,
          maxOpenPositions: formData.maxOpenPositions,
          minTradeSol,
          feeReserveSol,
          budgetSol: budgetForPreview,
          deployedSol: deployedSol ?? 0,
          fixedTradeAmountSol:
            formData.fixedTradeAmountSol === ""
              ? undefined
              : Number(formData.fixedTradeAmountSol),
          // Losses already realized only count toward the SAVED budget; a
          // different amount typed here starts a fresh tally.
          realizedLossSol:
            budgetForPreview !== null && budgetForPreview === savedBudget
              ? (realizedLossSol ?? 0)
              : 0,
        })
      : null;
  const sizingNote = describeSizing(
    sizing,
    balanceSol,
    formData.fixedTradeAmountSol === ""
      ? null
      : Number(formData.fixedTradeAmountSol)
  );
  const nextBuySol = sizing?.status === "ready" ? sizing.buySol : null;

  const handleSave = async () => {
    if (hasErrors(errors) || !loaded) return;
    setSaving(true);
    try {
      await updateGlobalSettings(toSettingsPayload(formData));
      dirty.current = false;
      toast.success("✅ Settings saved!");
    } catch (err: any) {
      console.error("Failed to save settings:", err);
      toast.error(
        `❌ Couldn't save settings: ${err?.message || "unknown error"}`
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    dirty.current = false;
    const ok = await refetch();
    if (ok) {
      toast.success("Reloaded your saved settings");
    } else {
      toast.error("⚠️ Couldn't reload your saved settings.");
    }
  };

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4 w-full">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-400" />
          Risk Management & Global Trading Settings
        </CardTitle>
        <p className="text-xs text-gray-500 mt-1">
          These settings apply to all tokens unless overridden.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {loadError && !loaded && (
          <div className="flex items-start justify-between gap-3 p-2.5 bg-red-900/20 border border-red-500/30 rounded-lg">
            <div className="text-xs text-red-300">
              <strong>Couldn&apos;t load your saved settings:</strong>{" "}
              {loadError}. Saving is disabled so the defaults shown here
              can&apos;t overwrite them.
            </div>
            <Button variant="outline" size="sm" onClick={handleReload}>
              Retry
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Max Open Positions — how many positions at once; the balance is
              split across them */}
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Max Open Positions
            </label>
            <input
              type="number"
              min="1"
              max="50"
              step="1"
              value={formData.maxOpenPositions}
              onChange={(e) =>
                setField("maxOpenPositions", Number(e.target.value))
              }
              className={INPUT_CLASS}
              placeholder="e.g. 5"
            />
            {errors.maxOpenPositions && (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.maxOpenPositions}
              </p>
            )}
          </div>

          {/* Fixed position size; blank preserves balance/free-slot splitting. */}
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Fixed SOL per trade (optional)
            </label>
            <input
              type="number"
              value={formData.fixedTradeAmountSol}
              onChange={(e) =>
                setField(
                  "fixedTradeAmountSol",
                  e.target.value === "" ? "" : Number(e.target.value)
                )
              }
              className={INPUT_CLASS}
              min="0.003"
              step="0.001"
              placeholder="Split balance across free slots"
            />
            {errors.fixedTradeAmountSol && (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.fixedTradeAmountSol}
              </p>
            )}
            <p className="text-[11px] text-gray-500 mt-0.5">
              Exact size; skipped if funds, budget, or the risk cap cannot cover it.
            </p>
          </div>

          {/* Min Market Cap */}
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Min Market Cap (SOL)
            </label>
            <input
              type="number"
              value={formData.minMarketCapSol}
              onChange={(e) =>
                setField("minMarketCapSol", Number(e.target.value))
              }
              className={INPUT_CLASS}
              min="0"
              step="1"
            />
            {solPriceUsd != null && (
              <p className="text-xs text-gray-500 mt-0.5">
                ~${(formData.minMarketCapSol * solPriceUsd).toLocaleString()}
              </p>
            )}
            {errors.minMarketCapSol && (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.minMarketCapSol}
              </p>
            )}
          </div>

          {/* Take Profit / Stop Loss */}
          <div className="p-2.5 bg-base-300 rounded-lg grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-400 mb-0.5 block">
                Take Profit (%)
              </label>
              <input
                type="number"
                value={formData.takeProfitPct}
                onChange={(e) =>
                  setField("takeProfitPct", Number(e.target.value))
                }
                className={INPUT_CLASS}
                min="0"
                max="100"
                step="1"
              />
              {errors.takeProfitPct && (
                <p className="text-xs text-red-500 mt-0.5">
                  {errors.takeProfitPct}
                </p>
              )}
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-0.5 block">
                Stop Loss (%)
              </label>
              <input
                type="number"
                value={formData.stopLossPct}
                onChange={(e) =>
                  setField("stopLossPct", Number(e.target.value))
                }
                className={INPUT_CLASS}
                min="0"
                max="100"
                step="0.5"
              />
              {errors.stopLossPct ? (
                <p className="text-xs text-red-500 mt-0.5">
                  {errors.stopLossPct}
                </p>
              ) : (
                slWarning && (
                  <p className="text-xs text-yellow-400 mt-0.5">{slWarning}</p>
                )
              )}
            </div>
            <p className="col-span-2 text-[11px] leading-snug text-gray-500">
              {EXIT_FILL_NOTE}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Minimum Launch Age */}
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Minimum age for eligibility at discovery (seconds){" "}
              <span className="text-gray-500">optional</span>
            </label>
            <input
              type="number"
              value={formData.minSecondsSinceLaunch}
              onChange={(e) =>
                setField(
                  "minSecondsSinceLaunch",
                  e.target.value === "" ? "" : Number(e.target.value)
                )
              }
              className={INPUT_CLASS}
              min="0"
              step="1"
              placeholder="None — buy immediately"
            />
            {errors.minSecondsSinceLaunch ? (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.minSecondsSinceLaunch}
              </p>
            ) : (
              <>
                {launchWarning ? (
                  <p className="text-xs text-yellow-400 mt-0.5">
                    {launchWarning}
                  </p>
                ) : (
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Younger tokens are skipped, not queued for later.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Max Total Trades */}
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Max Total Trades
            </label>
            <input
              type="number"
              value={formData.maxTotalTrades}
              onChange={(e) =>
                setField(
                  "maxTotalTrades",
                  e.target.value === "" ? "" : Number(e.target.value)
                )
              }
              className={INPUT_CLASS}
              min="1"
              step="1"
              placeholder="Unlimited"
            />
            {errors.maxTotalTrades ? (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.maxTotalTrades}
              </p>
            ) : (
              <p className="text-[11px] text-gray-500 mt-0.5">
                {config?.tradesTaken != null
                  ? `${config.tradesTaken} lifetime trades used; closed trades count and the total does not reset.`
                  : "Closed trades count toward this lifetime cap; it does not reset."}
              </p>
            )}
          </div>

          {/* Auto Trade */}
          <div className="p-2.5 bg-base-300 rounded-lg flex items-center justify-between">
            <span className="text-sm text-gray-400">Enable Auto Trading</span>
            <Switch
              checked={formData.autoTradeEnabled}
              onCheckedChange={(value: boolean) =>
                setField("autoTradeEnabled", value)
              }
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Slippage tolerance (%)
            </label>
            <input
              type="number"
              value={formData.slippagePct}
              onChange={(e) =>
                setField("slippagePct", Number(e.target.value))
              }
              className={INPUT_CLASS}
              min="0.1"
              max="100"
              step="0.1"
            />
            {errors.slippagePct && (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.slippagePct}
              </p>
            )}
            <p className="text-[11px] text-gray-500 mt-0.5">
              Shared by manual quotes, prepared swaps, and the recorded trade price.
            </p>
          </div>

          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Priority fee (SOL)
            </label>
            <input
              type="number"
              value={formData.priorityFeeSol}
              onChange={(e) =>
                setField("priorityFeeSol", Number(e.target.value))
              }
              className={INPUT_CLASS}
              min="0"
              max="0.01"
              step="0.00001"
            />
            {errors.priorityFeeSol && (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.priorityFeeSol}
              </p>
            )}
          </div>

          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Daily loss limit (%)
            </label>
            <input
              type="number"
              value={formData.maxDailyLossPct}
              onChange={(e) =>
                setField("maxDailyLossPct", Number(e.target.value))
              }
              className={INPUT_CLASS}
              min="0.1"
              max="100"
              step="0.1"
            />
            {errors.maxDailyLossPct && (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.maxDailyLossPct}
              </p>
            )}
            <p className="text-[11px] text-gray-500 mt-0.5">
              Reaching it pauses new buys until tomorrow; positions remain managed.
            </p>
          </div>

          <div className="p-2.5 bg-base-300 rounded-lg">
            <label className="text-xs text-gray-400 mb-0.5 block">
              Per-trade size cap (% of wallet equity)
            </label>
            <input
              type="number"
              value={formData.maxRiskPerTradePct}
              onChange={(e) =>
                setField("maxRiskPerTradePct", Number(e.target.value))
              }
              className={INPUT_CLASS}
              min="0.1"
              max="100"
              step="0.1"
            />
            {errors.maxRiskPerTradePct && (
              <p className="text-xs text-red-500 mt-0.5">
                {errors.maxRiskPerTradePct}
              </p>
            )}
            <p className="text-[11px] text-gray-500 mt-0.5">
              Hard cap for fixed-size and manual buys.
            </p>
          </div>
        </div>

        {/* Trading budget: protect profits by capping what the bot may trade */}
        <TradingBudgetControl
          enabled={formData.budgetEnabled}
          amount={formData.tradingBudgetSol}
          onChange={(next) => {
            setField("budgetEnabled", next.enabled);
            setField("tradingBudgetSol", next.amount);
          }}
          error={errors.tradingBudgetSol}
          balanceSol={balanceSol}
          maxOpenPositions={
            Number.isInteger(formData.maxOpenPositions)
              ? formData.maxOpenPositions
              : 1
          }
          fixedTradeAmountSol={
            formData.fixedTradeAmountSol === ""
              ? null
              : Number(formData.fixedTradeAmountSol)
          }
          savedBudgetSol={savedBudget}
          capitalSol={tradingCapitalSol}
          realizedLossSol={realizedLossSol}
          deployedSol={deployedSol}
          protectedProfitSol={protectedProfitSol}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* What a buy will actually be */}
          <div className="p-2.5 bg-base-300 rounded-lg border border-primary/20">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-400">
                Trading wallet balance
              </span>
              <span className="text-sm text-white">
                {balanceSol != null ? `${balanceSol.toFixed(4)} SOL` : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-400">Open positions</span>
              <span className="text-sm text-white">
                {openPositions != null ? openPositions : "—"} /{" "}
                {Number.isInteger(formData.maxOpenPositions)
                  ? formData.maxOpenPositions
                  : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400">Next position</span>
              <span className="text-lg font-bold text-primary">
                {nextBuySol != null ? `${nextBuySol.toFixed(4)} SOL` : "—"}
              </span>
            </div>
          </div>

          {/* Warning / Info */}
          {sizingNote?.tone === "warn" ? (
            <div className="flex items-start gap-2 p-2.5 bg-red-900/20 border border-red-500/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-red-300">{sizingNote.text}</div>
            </div>
          ) : (
            <div className="flex items-start gap-2 p-2.5 bg-blue-900/20 border border-blue-500/30 rounded-lg">
              <TrendingUp className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-blue-300">
                The bot splits your trading wallet&apos;s balance across up to{" "}
                {Number.isInteger(formData.maxOpenPositions)
                  ? formData.maxOpenPositions
                  : "N"}{" "}
                open positions, and stops opening new ones when they&apos;re all
                in use or the balance runs low.
                {sizingNote ? ` ${sizingNote.text}` : ""}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" onClick={handleReload}>
            Reload saved settings
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || loading || !loaded || hasErrors(errors)}
          >
            {saving ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
