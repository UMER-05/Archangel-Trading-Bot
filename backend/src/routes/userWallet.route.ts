// backend/src/routes/userWallet.route.ts
import { Router, Request, Response } from "express";
import { PublicKey } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import { getBalanceInSol } from "../services/solana.service.js";
import userWalletService, {
  sellCustodialPosition,
} from "../services/userWallet.service.js";
import dbService from "../services/db.service.js";
import {
  getMaxOpenPositions,
  getTraderConfig,
  setAutoTradeEnabled,
} from "../services/traderConfig.service.js";
import {
  budgetBreakdown,
  minBalanceForSlots,
  sizingEnv,
} from "../utils/positionSizing.js";
import { getRiskStatus } from "../services/riskManagement.service.js";
import { verifyWalletAuth } from "../utils/walletAuth.js";

const router = Router();
const log = getLogger("userWallet.route");

/**
 * GET /api/user-wallet/:ownerWallet
 * Returns (creating on first call) this owner's dedicated custodial
 * trading wallet address and its current SOL balance.
 */
router.get("/:ownerWallet", async (req: Request, res: Response) => {
  try {
    const { ownerWallet } = req.params;
    const result = await userWalletService.getUserWalletBalanceSol(
      ownerWallet!,
    );

    // What the dashboard needs to explain — concretely — whether the bot can
    // open another position for this wallet: how many slots the trader
    // allows, how many are in use, and the sizing floors. The split itself is
    // computed from these (utils/positionSizing.ts), on both sides.
    const [maxOpenPositions, openPositions, traderConfig] = await Promise.all([
      getMaxOpenPositions(ownerWallet!),
      dbService.getOpenPositionCount(ownerWallet!),
      getTraderConfig(ownerWallet!),
    ]);
    const { minTradeSol, feeReserveSol } = sizingEnv();

    // Trading budget: how much the bot may have at work in total (the budget
    // less losses realized since it was set), how much is at work now, and how
    // much cash is PROTECTED — beyond the capital the bot may use: profits and
    // later deposits it won't touch, withdrawable any time.
    const rawBudget = traderConfig?.globalSettings?.tradingBudgetSol;
    const tradingBudgetSol =
      typeof rawBudget === "number" && rawBudget > 0 ? rawBudget : null;
    const maxDailyLossPct =
      traderConfig?.globalSettings?.maxDailyLossPct ??
      Number(process.env.MAX_DAILY_LOSS_PCT ?? 6);
    const { deployedSol, realizedLossSol } =
      tradingBudgetSol !== null
        ? await dbService.getBudgetState(
            ownerWallet!,
            traderConfig?.globalSettings?.tradingBudgetSetAt ?? 0,
          )
        : { deployedSol: 0, realizedLossSol: 0 };
    const { capitalSol, protectedProfitSol } = budgetBreakdown({
      cashSol: result?.balanceSol ?? 0,
      feeReserveSol,
      budgetSol: tradingBudgetSol,
      deployedSol,
      realizedLossSol,
    });

    // The server-side safety limits that can also stop new buys, so the
    // dashboard can say so instead of leaving the user to guess: today's
    // loss against the daily limit, and the optional global position cap
    // (MAX_OPEN_POSITIONS in the server's .env; 0 = none).
    let risk: {
      dailyLossPct: number;
      maxDailyLossPct: number;
      serverMaxOpenPositions: number;
    } | null = null;
    try {
      const r = await getRiskStatus(
        ownerWallet!,
        result?.hotWalletPublicKey,
        { maxDailyLossPct },
      );
      risk = {
        dailyLossPct: r.dailyLossPct,
        maxDailyLossPct: r.maxDailyLossPct,
        serverMaxOpenPositions: r.maxOpenPositions,
      };
    } catch (err: any) {
      log.warn({ err: err?.message }, "Could not compute risk status");
    }

    return res.json({
      success: true,
      ...result,
      ...(risk ?? {}),
      maxOpenPositions,
      openPositions,
      tradingBudgetSol,
      tradingCapitalSol: tradingBudgetSol !== null ? capitalSol : null,
      realizedLossSol,
      deployedSol,
      protectedProfitSol,
      minTradeSol,
      feeReserveSol,
      fixedTradeAmountSol:
        traderConfig?.globalSettings?.fixedTradeAmountSol ?? null,
      // Enough to open every one of the trader's slots at the minimum size.
      minBalanceForAutoTradeSol: minBalanceForSlots(
        maxOpenPositions,
        minTradeSol,
        feeReserveSol,
      ),
    });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to load/create user wallet");
    return res.status(400).json({
      success: false,
      error: err.message || "Invalid wallet address",
    });
  }
});

/**
 * POST /api/user-wallet/:ownerWallet/withdraw
 * body: { amountSol, walletAuthTimestamp, walletAuthSignature }
 * Withdraws from this owner's custodial hot wallet back to their own
 * connected wallet — nowhere else. Requires proof (a fresh wallet
 * signature) that the caller actually controls :ownerWallet.
 */
/**
 * GET /api/user-wallet/:ownerWallet/owner-balance
 * SOL balance of the CONNECTED (owner) wallet itself, read through the
 * server's RPC. The dashboard used to read this straight from a public Solana
 * RPC in the browser; that node answers 403 to browser traffic, which left the
 * balance stuck at 0 and the manual Buy page reporting "Insufficient balance".
 * Reading it here reuses the backend's RPC without exposing its key.
 */
router.get(
  "/:ownerWallet/owner-balance",
  async (req: Request, res: Response) => {
    const { ownerWallet } = req.params;
    let owner: PublicKey;
    try {
      owner = new PublicKey(ownerWallet!);
    } catch {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet address" });
    }
    try {
      const balanceSol = await getBalanceInSol(owner);
      return res.json({ success: true, wallet: owner.toBase58(), balanceSol });
    } catch (err: any) {
      log.warn({ err: err?.message }, "Could not read owner wallet balance");
      return res
        .status(502)
        .json({ success: false, message: "Balance lookup failed" });
    }
  },
);

router.post("/:ownerWallet/withdraw", async (req: Request, res: Response) => {
  try {
    const { ownerWallet } = req.params;
    const { amountSol, walletAuthTimestamp, walletAuthSignature } = req.body;

    const verifiedWallet = verifyWalletAuth({
      wallet: ownerWallet,
      timestamp: walletAuthTimestamp,
      signature: walletAuthSignature,
    });
    if (!verifiedWallet) {
      return res.status(401).json({
        success: false,
        error:
          "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
      });
    }

    const result = await userWalletService.withdrawToOwner(
      verifiedWallet,
      Number(amountSol),
    );
    return res.json({ success: true, ...result });
  } catch (err: any) {
    log.error({ err: err.message }, "Withdrawal failed");
    return res.status(400).json({
      success: false,
      error: err.message || "Withdrawal failed",
    });
  }
});

/**
 * POST /api/user-wallet/:ownerWallet/stop-auto-trade
 * body: { walletAuthTimestamp, walletAuthSignature }
 * Disables auto-trade for this wallet and sells every position the bot has
 * bought for it (never touches self-custody/manual positions — those are
 * only sellable by the user themselves). Requires proof of ownership, same
 * as withdraw above, since this moves real funds.
 */
router.post(
  "/:ownerWallet/stop-auto-trade",
  async (req: Request, res: Response) => {
    try {
      const { ownerWallet } = req.params;
      const { walletAuthTimestamp, walletAuthSignature } = req.body;

      const verifiedWallet = verifyWalletAuth({
        wallet: ownerWallet,
        timestamp: walletAuthTimestamp,
        signature: walletAuthSignature,
      });
      if (!verifiedWallet) {
        return res.status(401).json({
          success: false,
          error:
            "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
        });
      }

      const io = (req.app as any).locals.io;
      const result = await userWalletService.stopAutoTradeAndLiquidate(
        verifiedWallet,
        io,
      );
      return res.json({ success: true, ...result });
    } catch (err: any) {
      log.error({ err: err.message }, "Stop auto-trade failed");
      return res.status(400).json({
        success: false,
        error: err.message || "Stop auto-trade failed",
      });
    }
  },
);

/**
 * POST /api/user-wallet/:ownerWallet/sell-position
 * body: { token, walletAuthTimestamp, walletAuthSignature }
 * Sells ONE position the bot holds for this wallet (from its trading wallet).
 * The dashboard's Sell button on a bot-bought position. "Sell All & Stop"
 * (stop-auto-trade above) is the sell-everything version of this.
 */
router.post(
  "/:ownerWallet/sell-position",
  async (req: Request, res: Response) => {
    try {
      const { ownerWallet } = req.params;
      const { token, walletAuthTimestamp, walletAuthSignature } =
        req.body ?? {};

      if (
        typeof token !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)
      ) {
        return res.status(400).json({
          success: false,
          error: "token must be a valid token mint address",
        });
      }

      const verifiedWallet = verifyWalletAuth({
        wallet: ownerWallet,
        timestamp: walletAuthTimestamp,
        signature: walletAuthSignature,
      });
      if (!verifiedWallet) {
        return res.status(401).json({
          success: false,
          error:
            "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
        });
      }

      const io = (req.app as any).locals.io;
      const outcome = await sellCustodialPosition(verifiedWallet, token, io);

      if (outcome.status === "failed") {
        return res.status(400).json({ success: false, error: outcome.error });
      }
      return res.json({ success: true, ...outcome });
    } catch (err: any) {
      log.error({ err: err.message }, "Failed to sell position");
      return res.status(400).json({
        success: false,
        error: err.message || "Failed to sell position",
      });
    }
  },
);

/**
 * POST /api/user-wallet/:ownerWallet/auto-trade
 * body: { enabled: boolean, walletAuthTimestamp, walletAuthSignature }
 * Pauses or resumes auto-trading for this wallet WITHOUT selling anything
 * and without touching any other saved setting. (stop-auto-trade above turns
 * it off AND liquidates every bot position; this is the gentle version —
 * open positions keep being managed by the exit monitor either way.)
 */
router.post("/:ownerWallet/auto-trade", async (req: Request, res: Response) => {
  try {
    const { ownerWallet } = req.params;
    const { enabled, walletAuthTimestamp, walletAuthSignature } =
      req.body ?? {};

    if (typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ success: false, error: "enabled must be true or false" });
    }

    const verifiedWallet = verifyWalletAuth({
      wallet: ownerWallet,
      timestamp: walletAuthTimestamp,
      signature: walletAuthSignature,
    });
    if (!verifiedWallet) {
      return res.status(401).json({
        success: false,
        error:
          "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
      });
    }

    const io = (req.app as any).locals.io;
    await setAutoTradeEnabled(verifiedWallet, enabled, io);
    return res.json({ success: true, autoTradeEnabled: enabled });
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to change auto-trade state");
    return res.status(400).json({
      success: false,
      error: err.message || "Failed to change auto-trade state",
    });
  }
});

export default router;
