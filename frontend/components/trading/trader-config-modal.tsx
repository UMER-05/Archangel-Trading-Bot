// frontend/components/trading/trader-config-modal.tsx
"use client";

import { useState, useEffect, useRef } from "react";
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
import {
  X,
  Settings,
  TrendingUp,
  AlertTriangle,
  DollarSign,
  Loader2,
} from "lucide-react";

interface TraderConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const INPUT_CLASS =
  "w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500";

export function TraderConfigModal({ isOpen, onClose }: TraderConfigModalProps) {
  const { config, updateGlobalSettings, loading, loadError, refetch } =
    useTraderConfig();
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
  const [saveError, setSaveError] = useState<string | null>(null);
  // True once the user has touched a field. A config update that arrives
  // after that (a socket broadcast, the periodic refresh) must not overwrite
  // what they're typing.
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
    setSaveError(null);
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const errors = validateGlobalSettings(formData);
  const launchWarning = launchAgeWarning(formData);
  const slWarning = stopLossWarning(formData);

  // The budget as currently typed (null when off or not a usable number).
  const budgetForPreview =
    formData.budgetEnabled &&
    formData.tradingBudgetSol !== "" &&
    Number(formData.tradingBudgetSol) > 0
      ? Number(formData.tradingBudgetSol)
      : null;

  // What the split means for the wallet as it is right now.
  const sizingNote =
    !errors.maxOpenPositions &&
    balanceSol != null &&
    minTradeSol != null &&
    feeReserveSol != null
      ? describeSizing(
          computePositionSize({
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
            realizedLossSol:
              budgetForPreview !== null && budgetForPreview === savedBudget
                ? (realizedLossSol ?? 0)
                : 0,
          }),
          balanceSol,
          formData.fixedTradeAmountSol === ""
            ? null
            : Number(formData.fixedTradeAmountSol)
        )
      : null;

  const handleSave = async () => {
    if (hasErrors(errors)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateGlobalSettings(toSettingsPayload(formData));
      dirty.current = false;
      toast.success("Settings saved");
      onClose();
    } catch (err: any) {
      // Stay open and say why. Closing here made a rejected save (bad
      // signature, value refused by the server, network down) look done.
      console.error("Failed to save settings:", err);
      setSaveError(err?.message || "Couldn't save your settings.");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  // Never show editable defaults while the real saved settings haven't
  // loaded — saving them would overwrite the user's actual configuration.
  const loaded = config != null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <Settings className="w-6 h-6 text-blue-400" />
            <h2 className="text-2xl font-bold text-white">
              Global Trading Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        {!loaded ? (
          <div className="p-6">
            {loadError ? (
              <div className="space-y-3">
                <p className="text-sm text-red-400">
                  Couldn&apos;t load your saved settings: {loadError}
                </p>
                <p className="text-xs text-gray-500">
                  Editing is disabled so defaults can&apos;t overwrite what you
                  have saved.
                </p>
                <button
                  onClick={() => void refetch()}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                >
                  Try again
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading your saved
                settings...
              </div>
            )}
          </div>
        ) : (
          <div className="p-6 space-y-6">
            {/* Market Cap */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-green-400" />
                <h3 className="text-lg font-semibold text-white">Market Cap</h3>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
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
                  {errors.minMarketCapSol ? (
                    <p className="text-xs text-red-500 mt-1">
                      {errors.minMarketCapSol}
                    </p>
                  ) : (
                    solPriceUsd != null && (
                      <p className="text-xs text-gray-500 mt-1">
                        ~$
                        {(
                          formData.minMarketCapSol * solPriceUsd
                        ).toLocaleString()}
                      </p>
                    )
                  )}
                </div>
              </div>
            </div>

            {/* TP/SL */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-400" />
                <h3 className="text-lg font-semibold text-white">
                  Take Profit / Stop Loss
                </h3>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
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
                  {errors.takeProfitPct ? (
                    <p className="text-xs text-red-500 mt-1">
                      {errors.takeProfitPct}
                    </p>
                  ) : (
                    <p className="text-xs text-green-500 mt-1">
                      Exit at +{formData.takeProfitPct}% profit
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
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
                    <p className="text-xs text-red-500 mt-1">
                      {errors.stopLossPct}
                    </p>
                  ) : (
                    <p className="text-xs text-red-500 mt-1">
                      Exit at -{formData.stopLossPct}% loss
                    </p>
                  )}
                  {slWarning && !errors.stopLossPct && (
                    <p className="text-xs text-yellow-400 mt-1">{slWarning}</p>
                  )}
                </div>
              </div>
              <p className="text-xs text-gray-500">{EXIT_FILL_NOTE}</p>
            </div>

            {/* Other Settings */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-purple-400" />
                <h3 className="text-lg font-semibold text-white">
                  Other Settings
                </h3>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Minimum age for eligibility at discovery (seconds){" "}
                    <span className="text-gray-500 font-normal">optional</span>
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
                    <p className="text-xs text-red-500 mt-1">
                      {errors.minSecondsSinceLaunch}
                    </p>
                  ) : launchWarning ? (
                    <p className="text-xs text-yellow-400 mt-1">
                      {launchWarning}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 mt-1">
                      {formData.minSecondsSinceLaunch === "" ||
                      Number(formData.minSecondsSinceLaunch) === 0
                        ? "No age filter — eligible tokens can be bought immediately."
                        : `Tokens younger than ${formData.minSecondsSinceLaunch}s at discovery are skipped; the bot does not wait and retry them.`}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    This is a skip filter, not a wait-before-buy delay.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Max Open Positions
                  </label>
                  <input
                    type="number"
                    value={formData.maxOpenPositions}
                    onChange={(e) =>
                      setField("maxOpenPositions", Number(e.target.value))
                    }
                    className={INPUT_CLASS}
                    min="1"
                    max="50"
                    step="1"
                  />
                  {errors.maxOpenPositions ? (
                    <p className="text-xs text-red-500 mt-1">
                      {errors.maxOpenPositions}
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-gray-500 mt-1">
                        {formData.fixedTradeAmountSol === ""
                          ? "When no fixed size is set, the bot splits available balance across these slots."
                          : "Each buy uses the fixed amount above; this still limits simultaneous positions."}{" "}
                        It stops opening new ones when every slot is in use or
                        the balance runs low.
                      </p>
                      {sizingNote && (
                        <p
                          className={`text-xs mt-1 ${
                            sizingNote.tone === "warn"
                              ? "text-yellow-400"
                              : sizingNote.tone === "ok"
                                ? "text-green-400"
                                : "text-blue-400"
                          }`}
                        >
                          {sizingNote.text}
                        </p>
                      )}
                    </>
                  )}
                </div>

                <div className="col-span-2">
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
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
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
                    <p className="text-xs text-red-500 mt-1">
                      {errors.fixedTradeAmountSol}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    Buys use this exact amount or are skipped if the wallet or
                    trading budget cannot cover it.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
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
                    <p className="text-xs text-red-500 mt-1">
                      {errors.maxTotalTrades}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 mt-1">
                      {config?.tradesTaken != null
                        ? `${config.tradesTaken} trade${
                            config.tradesTaken === 1 ? "" : "s"
                          } taken so far in this wallet's lifetime (closed trades count). `
                        : ""}
                      {formData.maxTotalTrades === ""
                        ? "The bot trades for you with no lifetime limit."
                        : `The bot stops trading for you after ${formData.maxTotalTrades} lifetime trade${
                            formData.maxTotalTrades === 1 ? "" : "s"
                          } — this counter does not reset; raise the cap to continue.`}
                    </p>
                  )}
                </div>

                <div className="col-span-2 grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
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
                      <p className="text-xs text-red-500 mt-1">
                        {errors.slippagePct}
                      </p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">
                      Applied consistently to quotes and swaps.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
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
                      <p className="text-xs text-red-500 mt-1">
                        {errors.priorityFeeSol}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
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
                      <p className="text-xs text-red-500 mt-1">
                        {errors.maxDailyLossPct}
                      </p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">
                      Reaching it pauses new buys until tomorrow; open
                      positions remain managed.
                    </p>
                  </div>

                </div>

                <div className="flex items-center">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.autoTradeEnabled}
                      onChange={(e) =>
                        setField("autoTradeEnabled", e.target.checked)
                      }
                      className="w-4 h-4 rounded border-gray-700 bg-gray-800 text-blue-500 focus:ring-blue-500"
                    />
                    <span className="text-sm font-medium text-gray-300">
                      Enable Auto Trading
                    </span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-gray-800 bg-gray-800/50">
          {saveError && (
            <p className="px-6 pt-4 text-sm text-red-400">
              Couldn&apos;t save: {saveError}
            </p>
          )}
          <div className="flex items-center justify-between p-6">
            <p className="text-sm text-gray-400">
              These settings apply to all tokens unless overridden
            </p>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                disabled={saving}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || loading || !loaded || hasErrors(errors)}
                className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "Saving..." : "Save Settings"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
