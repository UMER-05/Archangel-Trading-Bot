// backend/src/services/tokenFiltering.service.ts
//
// Phase 4 of the linear discovery→validate→buy pipeline (see
// candidatePipeline.service.ts): given a mint that Phase 3 already confirmed
// is tradeable on Jupiter, apply ArchAngel's own quality/safety criteria —
// exactly seven checks, none of which touch Jupiter or any third-party price
// API:
//
//   Phase 4
//   ├── Mint authority     (on-chain, straight from the mint account)
//   ├── Freeze authority   (on-chain, straight from the mint account)
//   ├── Buy tax            (RugCheck)
//   ├── Sell tax           (RugCheck)
//   ├── Honeypot           (RugCheck)
//   ├── Creator holdings   (on-chain token-account distribution)
//   └── Top 3 holdings     (on-chain token-account distribution)
//
// These run exactly once per token, globally, before any per-wallet
// execution — they don't depend on which wallet is buying or how much,
// unlike Phase 5/6 (see validationPipeline.service.ts) or the per-wallet
// launch-window/min-mcap checks in multiUserExecution.service.ts.
//
// There is deliberately no market-health/liquidity/volume check here
// anymore — that used to be a Birdeye call, and Birdeye has been removed
// from this codebase entirely (API-plan compute-unit limits made it an
// unreliable dependency for a check that runs on every single candidate).
// Liquidity is still gated — just by Jupiter itself, structurally, as part
// of Phase 3 (see jupiterTradeability.service.ts) and again immediately
// before each buy in Phase 6 (see validationPipeline.service.ts's
// pre-execution checks).
import { getLogger } from "../utils/logger.js";
import {
  fetchRugCheckReport,
  getHolderDistribution,
  getOnChainMintAuthorityStatus,
} from "./tokenSafetyChecks.service.js";

const LOG = getLogger("token-filtering");

export interface ArchAngelFilterConfig {
  maxBuyTax: number;
  maxSellTax: number;
  requireMintDisabled: boolean;
  requireFreezeDisabled: boolean;
  requireLpLocked: boolean;
  maxCreatorHoldingsPct?: number; // default 20
  maxTop3HoldingsPct?: number; // default 60
}

export interface FilterResult {
  approved: boolean;
  reason?: string;
  passedFilters: string[];
  failedFilters: string[];
  details: {
    mintAuthorityDisabled: boolean;
    freezeAuthorityDisabled: boolean;
    buyTax: number;
    sellTax: number;
    lpLocked: boolean;
    isHoneypot: boolean;
    creatorHoldingsPct?: number;
    top3HoldingsPct?: number;
  };
}

/**
 * Phase 4 — token filtering (ArchAngel criteria).
 *
 * `poolAddress`, when known (the webhook/pool-creation event supplies this
 * — see candidatePipeline.service.ts), is excluded from the holder-
 * concentration ranking so the AMM's own liquidity vault is never mistaken
 * for a whale wallet. There's no creator/deployer address available without
 * a token-metadata catalog lookup, so creator-holdings falls back to
 * "largest non-pool holder" — see getHolderDistribution's own doc comment.
 */
export async function applyArchAngelFilters(
  tokenMint: string,
  config: ArchAngelFilterConfig,
  poolAddress?: string,
): Promise<FilterResult> {
  const passedFilters: string[] = [];
  const failedFilters: string[] = [];

  const details: FilterResult["details"] = {
    mintAuthorityDisabled: false,
    freezeAuthorityDisabled: false,
    buyTax: 0,
    sellTax: 0,
    lpLocked: false,
    isHoneypot: false,
  };

  try {
    LOG.info(
      `🔍 [Phase 4] Applying ArchAngel filters for ${tokenMint.slice(0, 8)}...`,
    );

    // Mint/freeze authority — straight from the mint account on-chain.
    const authorityStatus = await getOnChainMintAuthorityStatus(tokenMint);
    if (!authorityStatus.available) {
      // Fail closed: can't confirm authorities are disabled, so don't treat
      // an RPC hiccup as "safe."
      if (config.requireMintDisabled)
        failedFilters.push("mint_authority_disabled");
      if (config.requireFreezeDisabled)
        failedFilters.push("freeze_authority_disabled");
      LOG.warn(
        `❌ [Phase 4] On-chain authority check unavailable for ${tokenMint.slice(0, 8)} — failing closed`,
      );
    } else {
      details.mintAuthorityDisabled = authorityStatus.mintAuthorityDisabled;
      details.freezeAuthorityDisabled = authorityStatus.freezeAuthorityDisabled;

      if (config.requireMintDisabled) {
        if (authorityStatus.mintAuthorityDisabled)
          passedFilters.push("mint_authority_disabled");
        else failedFilters.push("mint_authority_disabled");
      }
      if (config.requireFreezeDisabled) {
        if (authorityStatus.freezeAuthorityDisabled)
          passedFilters.push("freeze_authority_disabled");
        else failedFilters.push("freeze_authority_disabled");
      }
    }

    // Early exit on a critical authority failure — skip the slower API calls
    // below entirely, same reasoning as the old blended validator.
    if (failedFilters.length > 0) {
      return {
        approved: false,
        reason: `Failed ${failedFilters.length} critical check(s)`,
        passedFilters,
        failedFilters,
        details,
      };
    }

    // Tax + honeypot + LP lock all come from one RugCheck report.
    const report = await fetchRugCheckReport(tokenMint);
    if (!report.available) {
      // Fail closed: an outage must not read as "0% tax" / "not a honeypot" —
      // that's exactly backwards for checks whose whole job is catching a
      // hidden rug. This blocks trades we can't verify, not every trade.
      failedFilters.push(
        `buy_tax_under_${config.maxBuyTax}_pct`,
        `sell_tax_under_${config.maxSellTax}_pct`,
        "honeypot_check",
      );
      if (config.requireLpLocked) failedFilters.push("lp_locked");
      LOG.warn(
        `❌ [Phase 4] RugCheck unavailable for ${tokenMint.slice(0, 8)} — failing closed`,
      );
    } else {
      const { taxes, isHoneypot, lpLocked } = report;
      details.buyTax = taxes.buyTax;
      details.sellTax = taxes.sellTax;
      details.isHoneypot = isHoneypot;
      details.lpLocked = lpLocked;

      if (taxes.buyTax <= config.maxBuyTax)
        passedFilters.push(`buy_tax_under_${config.maxBuyTax}_pct`);
      else failedFilters.push(`buy_tax_under_${config.maxBuyTax}_pct`);

      if (taxes.sellTax <= config.maxSellTax)
        passedFilters.push(`sell_tax_under_${config.maxSellTax}_pct`);
      else failedFilters.push(`sell_tax_under_${config.maxSellTax}_pct`);

      if (!isHoneypot) passedFilters.push("honeypot_check");
      else failedFilters.push("honeypot_check");

      if (config.requireLpLocked) {
        if (lpLocked) passedFilters.push("lp_locked");
        else failedFilters.push("lp_locked");
      }
    }

    // Holder concentration — on-chain token-account data, with the pool
    // address (from the webhook event) excluded from the ranking so
    // liquidity isn't mistaken for a whale wallet.
    const maxCreatorPct = config.maxCreatorHoldingsPct ?? 20;
    const maxTop3Pct = config.maxTop3HoldingsPct ?? 60;
    const holderDist = await getHolderDistribution(tokenMint, {
      excludeOwners: [poolAddress],
    });
    if (!holderDist.available) {
      failedFilters.push(
        `creator_holdings_under_${maxCreatorPct}_pct`,
        `top3_holdings_under_${maxTop3Pct}_pct`,
      );
      LOG.warn(
        `❌ [Phase 4] Holder distribution unavailable for ${tokenMint.slice(0, 8)} — failing closed`,
      );
    } else {
      details.creatorHoldingsPct = holderDist.creatorHoldings;
      details.top3HoldingsPct = holderDist.top3Combined;
      if (holderDist.creatorHoldings <= maxCreatorPct) {
        passedFilters.push(`creator_holdings_under_${maxCreatorPct}_pct`);
      } else {
        failedFilters.push(`creator_holdings_under_${maxCreatorPct}_pct`);
      }
      if (holderDist.top3Combined <= maxTop3Pct) {
        passedFilters.push(`top3_holdings_under_${maxTop3Pct}_pct`);
      } else {
        failedFilters.push(`top3_holdings_under_${maxTop3Pct}_pct`);
      }
    }

    const approved = failedFilters.length === 0;
    if (approved) {
      LOG.info(
        { passed: passedFilters.length },
        `✅ [Phase 4] ArchAngel filters PASSED for ${tokenMint.slice(0, 8)}`,
      );
    } else {
      LOG.warn(
        { failedChecks: failedFilters },
        `❌ [Phase 4] ArchAngel filters FAILED for ${tokenMint.slice(0, 8)}`,
      );
    }

    return {
      approved,
      passedFilters,
      failedFilters,
      details,
      // Under exactOptionalPropertyTypes, an optional string field must be
      // either a real string or entirely absent from the object — assigning
      // it `undefined` explicitly (approved ? undefined : ...) is a type
      // error, not just a redundant value. Spreading in a conditional
      // one-key object omits the property outright on the approved path.
      ...(approved
        ? {}
        : { reason: `Failed ${failedFilters.length} filter(s)` }),
    };
  } catch (err: any) {
    LOG.error({ tokenMint, err: err?.message }, "ArchAngel filtering error");
    return {
      approved: false,
      reason: `Filtering error: ${err?.message}`,
      passedFilters,
      failedFilters: [...failedFilters, "filtering_error"],
      details,
    };
  }
}
