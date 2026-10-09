// backend/scripts/wallet-status.ts
//
// "Why isn't the bot buying for this wallet?" — checks, for ONE owner wallet,
// every gate the bot applies before opening a position, in the order it
// applies them, and says which one is stopping it. Changes nothing.
//
//   npx tsx scripts/wallet-status.ts --wallet OWNER_ADDRESS
//
// OWNER_ADDRESS is the full wallet address the user connects with (scripts/
// positions-cleanup.ts prints every owner address in full). Type the real
// address — not the angle brackets of a placeholder; PowerShell reads "<" as a
// redirect.
//
// Wallet-level gates only. Whether an individual token gets bought also depends
// on that token (Jupiter route, safety filters, its launch age against the
// user's Minimum Launch Age, its market cap against Min Market Cap) — those
// show up per token in the backend log and the dashboard's activity feed.
import "../src/utils/env.js"; // loads .env before anything reads it
import dbService from "../src/services/db.service.js";
import userWalletService from "../src/services/userWallet.service.js";
import { getTraderConfig } from "../src/services/traderConfig.service.js";
import { getBalanceInSol } from "../src/services/solana.service.js";
import { getRiskStatus } from "../src/services/riskManagement.service.js";
import {
  budgetBreakdown,
  computePositionSize,
  normalizeMaxOpenPositions,
  sizingEnv,
} from "../src/utils/positionSizing.js";
import { isBotManagedOpenPosition } from "../src/utils/positionState.js";

const args = process.argv.slice(2);
const i = args.indexOf("--wallet");
const owner = i >= 0 ? args[i + 1] : undefined;

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
type Gate = { name: string; ok: boolean; detail: string };

async function main() {
  if (!owner || owner.startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/wallet-status.ts --wallet OWNER_ADDRESS",
    );
    return 1;
  }

  const uw = await userWalletService.getUserWallet(owner).catch(() => null);
  if (!uw) {
    console.error(
      `No trading wallet exists for ${owner}. Check the address (full, exact case).`,
    );
    return 1;
  }

  const config = await getTraderConfig(owner);
  const g = config?.globalSettings ?? {};
  const cash = await getBalanceInSol(uw.hotWalletPublicKey);
  const positions = (await dbService.getPositions(owner)).filter(
    isBotManagedOpenPosition,
  );
  const tradesTaken = await dbService.getTotalTradesCount(owner);
  const risk = await getRiskStatus(owner, uw.hotWalletPublicKey);
  const { minTradeSol, feeReserveSol } = sizingEnv();
  const maxOpen = normalizeMaxOpenPositions(g.maxOpenPositions);
  const maxTotal = g.maxTotalTrades ?? null;
  const budgetSol =
    typeof g.tradingBudgetSol === "number" && g.tradingBudgetSol > 0
      ? g.tradingBudgetSol
      : null;
  const { deployedSol, realizedLossSol } =
    budgetSol !== null
      ? await dbService.getBudgetState(owner, g.tradingBudgetSetAt ?? 0)
      : { deployedSol: 0, realizedLossSol: 0 };
  const { capitalSol, protectedProfitSol } = budgetBreakdown({
    cashSol: cash,
    feeReserveSol,
    budgetSol,
    deployedSol,
    realizedLossSol,
  });

  console.log(`\nOwner wallet:    ${owner}`);
  console.log(
    `Trading wallet:  ${uw.hotWalletPublicKey}   (${cash.toFixed(4)} SOL)\n`,
  );

  console.log("Saved settings");
  console.log(
    `  Auto-trade:               ${g.autoTradeEnabled ? "ON" : "OFF"}`,
  );
  console.log(
    `  Max Open Positions:       ${g.maxOpenPositions ?? `not set (default ${maxOpen})`}`,
  );
  console.log(
    `  Trading budget:           ${
      budgetSol === null
        ? "off (the bot may use the whole wallet, profits included)"
        : `${budgetSol} SOL   (lost so far ${realizedLossSol.toFixed(4)} → capital ${capitalSol.toFixed(4)}, ${deployedSol.toFixed(4)} at work, ${protectedProfitSol.toFixed(4)} protected profit)`
    }`,
  );
  console.log(
    `  Max Total Trades:         ${maxTotal ?? "unlimited"}   (${tradesTaken} different tokens bought so far, closed ones included)`,
  );
  console.log(
    `  Min Launch Age (s):       ${g.minSecondsSinceLaunch ?? "not set (buys immediately)"}`,
  );
  console.log(`  Min Market Cap (SOL):     ${g.minMarketCapSol ?? "default"}`);
  console.log(
    `  Take profit / stop loss:  ${g.takeProfitPct ?? "default"} / ${g.stopLossPct ?? "default"}\n`,
  );

  console.log("Server limits (.env)");
  console.log(
    `  MIN_AUTO_TRADE_SOL:       ${minTradeSol}     TRADE_FEE_RESERVE_SOL: ${feeReserveSol}`,
  );
  console.log(
    `  MAX_OPEN_POSITIONS:       ${risk.maxOpenPositions > 0 ? risk.maxOpenPositions : "0 (no server cap)"}`,
  );
  console.log(`  MAX_DAILY_LOSS_PCT:       ${risk.maxDailyLossPct}%\n`);

  console.log(`Positions the bot counts as open (${positions.length}):`);
  for (const p of positions) {
    console.log(
      `  ${short(p.token)}   cost ${p.netSol.toFixed(4)} SOL   remaining ${p.remainingPct ?? "n/a"}%`,
    );
  }
  if (positions.length === 0) console.log("  none");

  const sizing = computePositionSize({
    balanceSol: cash,
    openPositions: positions.length,
    maxOpenPositions: maxOpen,
    minTradeSol,
    feeReserveSol,
    budgetSol,
    deployedSol,
    realizedLossSol,
  });

  const gates: Gate[] = [
    {
      name: "Auto-trade is on",
      ok: !!g.autoTradeEnabled,
      detail: g.autoTradeEnabled
        ? "on"
        : "OFF — turn it on in Trading Settings (or Resume Auto Trade)",
    },
    {
      name: "Wallet has a non-dust balance",
      ok: cash >= minTradeSol,
      detail: `${cash.toFixed(4)} SOL (needs at least ${minTradeSol})`,
    },
    {
      name: "Max Total Trades not used up",
      ok: !(maxTotal != null && maxTotal > 0 && tradesTaken >= maxTotal),
      detail:
        maxTotal != null && maxTotal > 0
          ? `${tradesTaken} of ${maxTotal} used — closed trades count; raise it in Trading Settings`
          : "no lifetime limit",
    },
    {
      name: "A position slot is free (Max Open Positions)",
      ok: sizing.ok || sizing.code !== "AT_CAPACITY",
      detail: `${positions.length} of ${maxOpen} slots in use`,
    },
    {
      name: "Server position cap (MAX_OPEN_POSITIONS)",
      ok:
        risk.maxOpenPositions <= 0 || positions.length < risk.maxOpenPositions,
      detail:
        risk.maxOpenPositions > 0
          ? `${positions.length} of ${risk.maxOpenPositions} — set in the server .env, applies to every wallet`
          : "not set",
    },
    {
      name: "Balance and trading budget can fund a position",
      ok: sizing.ok || sizing.code !== "LOW_BALANCE",
      detail: sizing.ok
        ? `next position ≈ ${sizing.buySol.toFixed(4)} SOL (${sizing.slotsUsed} of ${sizing.freeSlots} free slots affordable at the ${minTradeSol} SOL minimum${sizing.limitedBy === "budget" ? ", limited by the trading budget" : ""})`
        : sizing.code === "LOW_BALANCE"
          ? sizing.limitedBy === "budget"
            ? `trading budget used up (${deployedSol.toFixed(4)} SOL at work, ${realizedLossSol.toFixed(4)} of the ${budgetSol} SOL lost) — the rest of the wallet is protected; raise the budget to at least ${(sizing.neededBudgetSol ?? 0).toFixed(3)} SOL or wait for a position to close`
            : `low balance — needs at least ${sizing.neededSol.toFixed(3)} SOL`
          : "n/a",
    },
    {
      name: "Daily loss limit not hit",
      ok: risk.dailyLossPct < risk.maxDailyLossPct,
      detail: `${risk.dailyLossSol.toFixed(4)} SOL lost today = ${risk.dailyLossPct.toFixed(1)}% of the wallet's ${risk.portfolioValue.toFixed(4)} SOL (limit ${risk.maxDailyLossPct}%; resets at server midnight)`,
    },
  ];

  console.log("\nGates, in the order the bot applies them");
  for (const gate of gates) {
    console.log(
      `  ${gate.ok ? "PASS" : "FAIL"}  ${gate.name} — ${gate.detail}`,
    );
  }

  const blocking = gates.filter((x) => !x.ok);
  console.log(
    blocking.length === 0
      ? "\nVerdict: every wallet-level check passes. If it still isn't buying, the tokens themselves are being passed on (see the backend log / activity feed for the reason per token)."
      : `\nVerdict: the bot will NOT open a new position for this wallet — ${blocking[0]!.name.toLowerCase()} failed${blocking.length > 1 ? ` (and ${blocking.length - 1} more)` : ""}.`,
  );
  return 0;
}

const finish = (code: number) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500);
};
main()
  .then(finish)
  .catch((err) => {
    console.error("wallet-status failed:", err);
    finish(1);
  });
