// backend/scripts/exit-check.ts
//
// "Would auto-sell fire for this position right now?" — a DRY RUN of the
// live monitor's exit decision for ONE position, using the exact same
// exported constants and functions monitor.service.ts trades on
// (isSellInBackoffCooldown, getMintDecimals, resolveExitCause, the TP/SL/tier
// defaults). It never calls routeSell, never writes to the database, and
// never touches the exit-claim lease — it only reads and reports.
//
//   npx tsx scripts/exit-check.ts --wallet OWNER_ADDRESS --token TOKEN_MINT
//
// OWNER_ADDRESS is the wallet the position was bought for (the dashboard's
// connected wallet, not the trading/hot wallet); scripts/wallet-status.ts and
// scripts/positions-cleanup.ts both print owner addresses in full if you need
// to find one. TOKEN_MINT is the position's token mint address.
//
// Read this top to bottom: it stops at the first thing that would make the
// live monitor skip this position too, exactly like monitor.service.ts's own
// tick() does — so "why hasn't it sold" usually has its answer in the last
// line printed before it stops.
import "../src/utils/env.js"; // loads .env before anything reads it
import dbService from "../src/services/db.service.js";
import { getEffectiveConfig } from "../src/services/traderConfig.service.js";
import { getQuoteImpliedPriceSol } from "../src/services/jupiter.service.js";
import {
  DEFAULT_SL_PCT,
  DEFAULT_TP_PCT,
  TIER1_PROFIT_PCT,
  TIER2_PROFIT_PCT,
  TIER3_PROFIT_PCT,
  TIER_SELL_PCT,
  TRAILING_ACTIVATION_PCT,
  TRAILING_STOP_PCT,
  getMintDecimals,
  isSellInBackoffCooldown,
  resolveExitCause,
} from "../src/services/monitor.service.js";

const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const wallet = valueOf("--wallet");
const token = valueOf("--token");

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

async function main(): Promise<number> {
  console.log(
    "DRY RUN — this reads state only. It never sells, and never writes to the database.\n",
  );

  if (!wallet || !token) {
    console.error(
      "Usage: npx tsx scripts/exit-check.ts --wallet OWNER_ADDRESS --token TOKEN_MINT",
    );
    return 1;
  }

  const positions = await dbService.getPositions(wallet);
  const pos = positions.find((p) => p.token === token);
  if (!pos) {
    console.error(
      `No position found for wallet ${wallet} / token ${token}. Check both addresses are exact and full (case matters).`,
    );
    return 1;
  }

  console.log(`Wallet:    ${wallet}`);
  console.log(`Token:     ${token}`);
  console.log(
    `Custody:   ${pos.custody ?? "(not set — treated as bot-managed)"}`,
  );
  console.log(`netSol:    ${pos.netSol.toFixed(6)}`);
  console.log(`Remaining: ${pos.remainingPct ?? 100}%\n`);

  if (pos.custody === "self") {
    console.log(
      "STOP — this is a self-custody (manual) position. The bot never auto-sells these; it lives in your own wallet, which only you can sign for. Sell it from the Sell page.",
    );
    return 0;
  }

  const remainingPct = pos.remainingPct ?? 100;
  if (remainingPct <= 0) {
    console.log("STOP — this position is already fully closed (remaining 0%).");
    return 0;
  }

  const dustThreshold = Number(
    process.env.POSITION_DUST_THRESHOLD_SOL ?? 0.0005,
  );
  if (!pos.netSol || pos.netSol < dustThreshold) {
    console.log(
      `STOP — netSol (${pos.netSol}) is below the dust threshold (${dustThreshold}); the monitor treats this as economically closed.`,
    );
    return 0;
  }

  if (isSellInBackoffCooldown(pos)) {
    const last = pos.lastSellAttemptAt
      ? new Date(pos.lastSellAttemptAt).toLocaleString()
      : "unknown";
    console.log(
      `STOP (for now) — this position is in sell-failure backoff: ${pos.sellFailureCount ?? 0} consecutive failed sell attempt(s), last at ${last}. It will be retried automatically as the backoff window (up to 60s) elapses. Check the backend log around that time for "Auto-sell swap failed" or "Emergency exit failed" for the real error.`,
    );
    return 0;
  }

  const walletConfig = await getEffectiveConfig(wallet, token);
  const tpPct =
    typeof pos.tpPct === "number" ? pos.tpPct : walletConfig.takeProfitPct;
  const slPct =
    typeof pos.slPct === "number" ? pos.slPct : walletConfig.stopLossPct;
  console.log(
    `Take profit: ${pct(tpPct)}${typeof pos.tpPct !== "number" ? " (wallet default — this position never got its own)" : ""}`,
  );
  console.log(
    `Stop loss:   ${pct(slPct)}${typeof pos.slPct !== "number" ? " (wallet default — this position never got its own)" : ""}\n`,
  );
  if (tpPct === DEFAULT_TP_PCT && slPct === DEFAULT_SL_PCT) {
    console.log(
      `(These match the server's built-in defaults of ${pct(DEFAULT_TP_PCT)} / ${pct(DEFAULT_SL_PCT)}.)\n`,
    );
  }

  // Position (db.service.ts) doesn't carry a cached `decimals` field the way
  // monitor.service.ts's locally-extended MonitorPosition can; getMintDecimals
  // has its own module-level cache, so this still avoids a repeat RPC call.
  const decimals = await getMintDecimals(token);
  if (decimals === null) {
    console.log(
      "STOP — couldn't read this token's decimals from the RPC. The live monitor stops here too rather than guess a sell amount. Check RPC connectivity/rate limits.",
    );
    return 0;
  }

  let avgBuy = pos.avgBuyPrice;
  if (typeof avgBuy !== "number" || !(avgBuy > 0)) {
    avgBuy =
      (await dbService.recoverPositionCostBasis(token, wallet)) ?? undefined;
    if (avgBuy)
      console.log(`(Cost basis recovered from buy history: ${avgBuy})`);
  }
  if (typeof avgBuy !== "number" || !(avgBuy > 0)) {
    console.log(
      "STOP — no cost basis (avgBuyPrice) could be found or recovered. The live monitor refuses to compare a real price against an invented entry price, so it skips this position too — this position cannot be auto-sold until it has one.",
    );
    return 0;
  }
  console.log(`Cost basis (avg buy price, SOL/token): ${avgBuy}`);

  const currentPrice = await getQuoteImpliedPriceSol(token, decimals);
  if (!currentPrice) {
    console.log(
      'STOP — no trustworthy current price from Jupiter right now (no route, or the request failed/was rate-limited). The live monitor defers TP/SL evaluation in exactly this situation — this is very likely why it "isn\'t working": check the backend log for Jupiter 429s or "No trustworthy price" around this token.',
    );
    return 0;
  }
  console.log(`Current price (SOL/token): ${currentPrice}`);

  const pnlPercent = (currentPrice - avgBuy) / avgBuy;
  console.log(`P&L: ${pct(pnlPercent)}\n`);

  const highestPnl = pos.highestPnlPct ?? pnlPercent;
  const newHighest = Math.max(highestPnl, pnlPercent);
  const trailingActive =
    pos.trailingActivated || newHighest >= TRAILING_ACTIVATION_PCT;
  const isLastTenPercent = remainingPct <= 10;
  const trailingStopForFinal =
    isLastTenPercent &&
    trailingActive &&
    newHighest - pnlPercent >= TRAILING_STOP_PCT;
  console.log(
    `Trailing stop: ${trailingActive ? "armed" : "not armed"} (peak ${pct(newHighest)}, activates at ${pct(TRAILING_ACTIVATION_PCT)}); applies once remaining ≤ 10% and only fires there once it's pulled back ${pct(TRAILING_STOP_PCT)} from peak.`,
  );

  // Tier checks — mirrors monitor.service.ts's tick() exactly; kept in sync
  // by hand since the trigger logic there is inline, not a separate function.
  // A tier only applies below this position's take profit (see that file's
  // comment for why) and each fires once (soldAt40/80/150).
  const tiers: { label: string; level: number; already: boolean }[] = [
    {
      label: "Tier 1 (+40%)",
      level: TIER1_PROFIT_PCT,
      already: !!pos.soldAt40,
    },
    {
      label: "Tier 2 (+80%)",
      level: TIER2_PROFIT_PCT,
      already: !!pos.soldAt80,
    },
    {
      label: "Tier 3 (+150%)",
      level: TIER3_PROFIT_PCT,
      already: !!pos.soldAt150,
    },
  ];
  for (const t of tiers) {
    const applies = t.level < tpPct;
    const hit = applies && !t.already && pnlPercent >= t.level;
    console.log(
      `${t.label}: ${
        !applies
          ? `doesn't apply (at/above this position's ${pct(tpPct)} take profit)`
          : t.already
            ? "already taken"
            : hit
              ? `WOULD SELL ${TIER_SELL_PCT}% now`
              : "not reached yet"
      }`,
    );
  }
  console.log("");

  const exitCause = resolveExitCause(
    pnlPercent,
    tpPct,
    slPct,
    isLastTenPercent && trailingStopForFinal,
  );

  const claim = await dbService.getPositionExitClaimState(token, wallet);
  if (claim) {
    const leased = new Date(claim.leaseUntil).getTime() > Date.now();
    console.log(
      `Exit claim: status=${claim.status}${
        claim.status === "claimed"
          ? `, ${leased ? "currently leased" : "lease EXPIRED — reclaimable by the next attempt"} until ${new Date(claim.leaseUntil).toLocaleString()}`
          : ""
      } (owner ${claim.ownerId})`,
    );
    if (claim.status === "claimed" && leased && !exitCause) {
      console.log(
        "(Not relevant right now since no exit condition is met, but note this position currently shows as claimed — a sell may already be in flight from another process/tick.)",
      );
    }
  } else {
    console.log(
      "Exit claim: none — nothing is currently mid-sell for this position.",
    );
  }
  console.log("");

  if (exitCause) {
    console.log(
      `VERDICT: would sell now — ${exitCause} triggered (P&L ${pct(pnlPercent)} vs TP ${pct(tpPct)} / SL -${pct(slPct)}).`,
    );
    if (
      claim?.status === "claimed" &&
      new Date(claim.leaseUntil).getTime() > Date.now()
    ) {
      console.log(
        "It hasn't sold yet because another attempt currently holds the exit claim — it will proceed once that releases (or the lease expires, within 2 minutes).",
      );
    }
  } else {
    console.log(
      `VERDICT: no exit condition met right now. Needs P&L ≥ ${pct(tpPct)} (take profit) or ≤ -${pct(slPct)} (stop loss)${trailingActive ? `, or (in the final 10%) a ${pct(TRAILING_STOP_PCT)} pullback from the ${pct(newHighest)} peak` : ""} — currently at ${pct(pnlPercent)}.`,
    );
  }
  return 0;
}

const finish = (code: number) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500);
};
main()
  .then(finish)
  .catch((err) => {
    console.error("exit-check failed:", err);
    finish(1);
  });
