import { describe, it, expect } from "vitest";
import {
  DEFAULT_GLOBAL_SETTINGS_FORM,
  decimalToPercent,
  formFromSettings,
  hasErrors,
  launchAgeWarning,
  stopLossWarning,
  percentToDecimal,
  toSettingsPayload,
  validateGlobalSettings,
  validateTakeProfitStopLoss,
  type GlobalSettingsForm,
} from "../globalSettings";

const valid = (over: Partial<GlobalSettingsForm> = {}): GlobalSettingsForm => ({
  ...DEFAULT_GLOBAL_SETTINGS_FORM,
  ...over,
});

describe("percent conversion", () => {
  it("does not leak float noise", () => {
    expect(decimalToPercent(0.07)).toBe(7);
    expect(decimalToPercent(0.3)).toBe(30);
    expect(percentToDecimal(7)).toBe(0.07);
    expect(percentToDecimal(0.5)).toBe(0.005);
  });
});

describe("formFromSettings", () => {
  it("uses defaults for a wallet that has never saved settings", () => {
    expect(formFromSettings({})).toEqual(DEFAULT_GLOBAL_SETTINGS_FORM);
    expect(formFromSettings(undefined)).toEqual(DEFAULT_GLOBAL_SETTINGS_FORM);
  });

  it("shows stored decimals as clean percentages", () => {
    const f = formFromSettings({
      takeProfitPct: 0.07,
      stopLossPct: 0.25,
      minSecondsSinceLaunch: 0,
      maxTotalTrades: 2,
      autoTradeEnabled: true,
    });
    expect(f.takeProfitPct).toBe(7);
    expect(f.stopLossPct).toBe(25);
    expect(f.minSecondsSinceLaunch).toBe(0);
    expect(f.maxTotalTrades).toBe(2);
    expect(f.autoTradeEnabled).toBe(true);
  });

  it("treats a stored null cap as unlimited (blank)", () => {
    expect(formFromSettings({ maxTotalTrades: null }).maxTotalTrades).toBe("");
  });
});

describe("validateGlobalSettings", () => {
  it("accepts the defaults, including a blank launch age and blank cap", () => {
    expect(hasErrors(validateGlobalSettings(valid()))).toBe(false);
  });

  it("rejects take profit above 100% (the server would refuse it)", () => {
    expect(
      validateGlobalSettings(valid({ takeProfitPct: 200 })).takeProfitPct
    ).toBeTruthy();
    expect(
      validateGlobalSettings(valid({ takeProfitPct: 100 })).takeProfitPct
    ).toBeUndefined();
  });

  it("rejects 0% take profit / stop loss (would exit immediately)", () => {
    expect(
      validateGlobalSettings(valid({ takeProfitPct: 0 })).takeProfitPct
    ).toBeTruthy();
    expect(
      validateGlobalSettings(valid({ stopLossPct: 0 })).stopLossPct
    ).toBeTruthy();
  });

  it("rejects stop loss above 100%", () => {
    expect(
      validateGlobalSettings(valid({ stopLossPct: 101 })).stopLossPct
    ).toBeTruthy();
  });

  it("validates launch age only when one is entered", () => {
    expect(
      validateGlobalSettings(valid({ minSecondsSinceLaunch: "" }))
        .minSecondsSinceLaunch
    ).toBeUndefined();
    expect(
      validateGlobalSettings(valid({ minSecondsSinceLaunch: 0 }))
        .minSecondsSinceLaunch
    ).toBeUndefined();
    expect(
      validateGlobalSettings(valid({ minSecondsSinceLaunch: -1 }))
        .minSecondsSinceLaunch
    ).toBeTruthy();
    expect(
      validateGlobalSettings(valid({ minSecondsSinceLaunch: 31 * 24 * 3600 }))
        .minSecondsSinceLaunch
    ).toBeTruthy();
  });

  it("validates Max Total Trades", () => {
    expect(
      validateGlobalSettings(valid({ maxTotalTrades: "" })).maxTotalTrades
    ).toBeUndefined();
    expect(
      validateGlobalSettings(valid({ maxTotalTrades: 5 })).maxTotalTrades
    ).toBeUndefined();
    expect(
      validateGlobalSettings(valid({ maxTotalTrades: 0 })).maxTotalTrades
    ).toBeTruthy();
    expect(
      validateGlobalSettings(valid({ maxTotalTrades: 2.5 })).maxTotalTrades
    ).toBeTruthy();
    expect(
      validateGlobalSettings(valid({ maxTotalTrades: 100001 })).maxTotalTrades
    ).toBeTruthy();
  });

  it("accepts a whole number of open positions from 1 to 50", () => {
    expect(
      validateGlobalSettings(valid({ maxOpenPositions: 1 })).maxOpenPositions
    ).toBeUndefined();
    expect(
      validateGlobalSettings(valid({ maxOpenPositions: 5 })).maxOpenPositions
    ).toBeUndefined();
    expect(
      validateGlobalSettings(valid({ maxOpenPositions: 50 })).maxOpenPositions
    ).toBeUndefined();
  });

  it("rejects an invalid Max Open Positions", () => {
    for (const bad of [0, -1, 2.5, 51, NaN]) {
      expect(
        validateGlobalSettings(valid({ maxOpenPositions: bad }))
          .maxOpenPositions
      ).toBeTruthy();
    }
  });

  it("rejects a negative market cap", () => {
    expect(
      validateGlobalSettings(valid({ minMarketCapSol: -1 })).minMarketCapSol
    ).toBeTruthy();
  });
});

describe("validateTakeProfitStopLoss", () => {
  it("is the same rule the global form uses", () => {
    expect(validateTakeProfitStopLoss(10, 30)).toEqual({});
    expect(validateTakeProfitStopLoss(200, 30).takeProfitPct).toBeTruthy();
    expect(validateTakeProfitStopLoss(10, 0).stopLossPct).toBeTruthy();
  });
});

describe("launchAgeWarning", () => {
  it("is silent for blank, zero and short waits", () => {
    expect(launchAgeWarning(valid({ minSecondsSinceLaunch: "" }))).toBeNull();
    expect(launchAgeWarning(valid({ minSecondsSinceLaunch: 0 }))).toBeNull();
    expect(launchAgeWarning(valid({ minSecondsSinceLaunch: 10 }))).toBeNull();
  });

  it("warns when the wait is long enough to skip most tokens", () => {
    expect(launchAgeWarning(valid({ minSecondsSinceLaunch: 60 }))).toContain(
      "skip most tokens"
    );
  });
});

describe("toSettingsPayload", () => {
  it("stores a blank launch age as 0 and a blank cap as null", () => {
    const p = toSettingsPayload(valid());
    expect(p.minSecondsSinceLaunch).toBe(0);
    expect(p.maxTotalTrades).toBeNull();
  });

  it("sends the open-position count and leaves fixed sizing disabled by default", () => {
    const p = toSettingsPayload(valid({ maxOpenPositions: 4 }));
    expect(p.maxOpenPositions).toBe(4);
    expect(p.fixedTradeAmountSol).toBeNull();
  });

  it("converts percentages back to decimals the server accepts", () => {
    const p = toSettingsPayload(
      valid({
        takeProfitPct: 50,
        stopLossPct: 25,
        maxTotalTrades: 5,
        minSecondsSinceLaunch: 3,
      })
    );
    expect(p.takeProfitPct).toBe(0.5);
    expect(p.stopLossPct).toBe(0.25);
    expect(p.maxTotalTrades).toBe(5);
    expect(p.minSecondsSinceLaunch).toBe(3);
  });

  it("round-trips through the form without drifting", () => {
    const p = toSettingsPayload(
      formFromSettings({ takeProfitPct: 0.07, stopLossPct: 0.3 })
    );
    expect(p.takeProfitPct).toBe(0.07);
    expect(p.stopLossPct).toBe(0.3);
  });

  it("round-trips execution and risk settings", () => {
    const payload = toSettingsPayload(
      valid({
        fixedTradeAmountSol: 0.25,
        slippagePct: 1.25,
        priorityFeeSol: 0.00005,
        maxDailyLossPct: 5,
        maxRiskPerTradePct: 1.5,
      })
    );
    expect(payload.fixedTradeAmountSol).toBe(0.25);
    expect(payload.slippageBps).toBe(125);
    expect(payload.priorityFeeSol).toBe(0.00005);
    expect(payload.maxDailyLossPct).toBe(5);
    expect(payload.maxRiskPerTradePct).toBe(1.5);
    expect(
      toSettingsPayload(
        formFromSettings({
          fixedTradeAmountSol: 0.25,
          slippageBps: 125,
          priorityFeeSol: 0.00005,
          maxDailyLossPct: 5,
          maxRiskPerTradePct: 1.5,
        })
      )
    ).toEqual(payload);
  });
});

describe("execution and risk settings validation", () => {
  it("rejects invalid fixed amount, slippage, priority fee, and risk limits", () => {
    const errors = validateGlobalSettings(
      valid({
        fixedTradeAmountSol: 0,
        slippagePct: 0,
        priorityFeeSol: 0.02,
        maxDailyLossPct: 101,
        maxRiskPerTradePct: 0,
      })
    );
    expect(errors.fixedTradeAmountSol).toBeTruthy();
    expect(errors.slippagePct).toBeTruthy();
    expect(errors.priorityFeeSol).toBeTruthy();
    expect(errors.maxDailyLossPct).toBeTruthy();
    expect(errors.maxRiskPerTradePct).toBeTruthy();
  });
});

describe("trading budget", () => {
  it("is off by default and sends null, so the server lets the bot use the whole wallet", () => {
    const p = toSettingsPayload(valid());
    expect(p.tradingBudgetSol).toBeNull();
  });

  it("loads a saved budget as enabled, and no budget as disabled", () => {
    const on = formFromSettings({ tradingBudgetSol: 1.5 });
    expect(on.budgetEnabled).toBe(true);
    expect(on.tradingBudgetSol).toBe(1.5);
    const off = formFromSettings({ tradingBudgetSol: null });
    expect(off.budgetEnabled).toBe(false);
    expect(off.tradingBudgetSol).toBe("");
  });

  it("requires a positive amount while enabled", () => {
    expect(
      validateGlobalSettings(
        valid({ budgetEnabled: true, tradingBudgetSol: "" })
      ).tradingBudgetSol
    ).toBeTruthy();
    expect(
      validateGlobalSettings(
        valid({ budgetEnabled: true, tradingBudgetSol: 0 })
      ).tradingBudgetSol
    ).toBeTruthy();
    expect(
      validateGlobalSettings(
        valid({ budgetEnabled: true, tradingBudgetSol: -1 })
      ).tradingBudgetSol
    ).toBeTruthy();
    expect(
      validateGlobalSettings(
        valid({ budgetEnabled: true, tradingBudgetSol: 2e6 })
      ).tradingBudgetSol
    ).toBeTruthy();
    expect(
      validateGlobalSettings(
        valid({ budgetEnabled: true, tradingBudgetSol: 1 })
      ).tradingBudgetSol
    ).toBeUndefined();
  });

  it("ignores the amount while disabled", () => {
    expect(
      validateGlobalSettings(
        valid({ budgetEnabled: false, tradingBudgetSol: "" })
      ).tradingBudgetSol
    ).toBeUndefined();
    expect(
      toSettingsPayload(valid({ budgetEnabled: false, tradingBudgetSol: 3 }))
        .tradingBudgetSol
    ).toBeNull();
  });

  it("sends the amount when enabled", () => {
    expect(
      toSettingsPayload(valid({ budgetEnabled: true, tradingBudgetSol: 2.5 }))
        .tradingBudgetSol
    ).toBe(2.5);
  });

  it("round-trips through the form without losing or inventing a budget", () => {
    expect(
      toSettingsPayload(formFromSettings({ tradingBudgetSol: 1.25 }))
        .tradingBudgetSol
    ).toBe(1.25);
    expect(toSettingsPayload(formFromSettings({})).tradingBudgetSol).toBeNull();
  });
});

describe("stopLossWarning", () => {
  it("warns on a stop loss inside price noise (e.g. 0.5 typed instead of 50)", () => {
    expect(stopLossWarning(valid({ stopLossPct: 0.5 }))).toContain("0.5%");
    expect(stopLossWarning(valid({ stopLossPct: 1.9 }))).toBeTruthy();
  });

  it("is silent for a sensible stop loss, and for invalid values (the error already covers those)", () => {
    expect(stopLossWarning(valid({ stopLossPct: 2 }))).toBeNull();
    expect(stopLossWarning(valid({ stopLossPct: 30 }))).toBeNull();
    expect(stopLossWarning(valid({ stopLossPct: 0 }))).toBeNull();
    expect(stopLossWarning(valid({ stopLossPct: NaN }))).toBeNull();
  });
});
