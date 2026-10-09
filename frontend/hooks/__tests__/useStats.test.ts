import { describe, it, expect, beforeEach } from "vitest";
import { useStats } from "../useStats";

// Zustand stores are plain modules with global state, so reset it before
// every test rather than re-importing (imports are cached across tests).
const initialStats = {
  portfolioValue: 0,
  totalProfitSol: 0,
  totalProfitPercent: 0,
  openTrades: 0,
  tradeVolumeSol: 0,
  winRate: 0,
  initialBalance: 0,
};

beforeEach(() => {
  useStats.setState({ stats: { ...initialStats }, tradeHistory: [], loading: true });
});

describe("useStats store", () => {
  it("merges partial updates into stats without clobbering other fields", () => {
    useStats.getState().updateStats({ portfolioValue: 5 });
    useStats.getState().updateStats({ totalProfitSol: 1.5 });

    const { stats } = useStats.getState();
    expect(stats.portfolioValue).toBe(5);
    expect(stats.totalProfitSol).toBe(1.5);
  });

  it("supports a functional updater that reads previous state", () => {
    useStats.getState().updateStats({ tradeVolumeSol: 10 });
    useStats
      .getState()
      .updateStats((prev) => ({ tradeVolumeSol: prev.tradeVolumeSol + 5 }));

    expect(useStats.getState().stats.tradeVolumeSol).toBe(15);
  });

  it("prepends new trades to history, most recent first", () => {
    useStats.getState().addTrade({
      id: "1",
      type: "buy",
      token: "A",
      amount: 1,
      pnl: 0,
      timestamp: 1,
    });
    useStats.getState().addTrade({
      id: "2",
      type: "sell",
      token: "B",
      amount: 1,
      pnl: 0.1,
      timestamp: 2,
    });

    const { tradeHistory } = useStats.getState();
    expect(tradeHistory[0].id).toBe("2");
    expect(tradeHistory[1].id).toBe("1");
  });

  it("caps trade history at 200 entries", () => {
    for (let i = 0; i < 250; i++) {
      useStats.getState().addTrade({
        id: String(i),
        type: "buy",
        token: "A",
        amount: 1,
        pnl: 0,
        timestamp: i,
      });
    }
    expect(useStats.getState().tradeHistory.length).toBe(200);
    // Most recent 200 survive — the newest one (249) stays, the oldest (0) is evicted.
    expect(useStats.getState().tradeHistory[0].id).toBe("249");
    expect(
      useStats.getState().tradeHistory.some((t) => t.id === "0")
    ).toBe(false);
  });

  it("toggles the loading flag", () => {
    useStats.getState().setLoading(false);
    expect(useStats.getState().loading).toBe(false);
  });
});
