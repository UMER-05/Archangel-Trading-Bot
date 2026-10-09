// backend/src/routes/user.route.ts
import express from "express";
import { getLogger } from "../utils/logger.js";
import dbService from "../services/db.service.js";
import { verifyWalletAuth } from "../utils/walletAuth.js";

const router = express.Router();
const log = getLogger("user.route");

// POST /api/user/settings
// body: { wallet, autoTrade?, selectedToken? }
// Field names mirror frontend/hooks/useConfig.ts's TradingConfig exactly so
// the frontend can apply the saved doc straight back into the store.
router.post("/settings", async (req, res) => {
  try {
    const {
      wallet,
      autoTrade,
      selectedToken,
      walletAuthTimestamp,
      walletAuthSignature,
    } = req.body;

    if (!wallet) {
      return res
        .status(400)
        .json({ success: false, message: "wallet required" });
    }

    // Without this, POSTing a different `wallet` field would silently
    // overwrite anyone else's saved trading config.
    const verifiedWallet = verifyWalletAuth({
      wallet,
      timestamp: walletAuthTimestamp,
      signature: walletAuthSignature,
    });
    if (!verifiedWallet) {
      return res.status(401).json({
        success: false,
        message:
          "Wallet signature required or invalid — sign the auth message with the connected wallet and retry.",
      });
    }

    const saved = await dbService.saveUserSettings(verifiedWallet, {
      autoTrade,
      selectedToken,
    });

    log.info({ wallet }, "Saved user settings");

    return res.json({ success: true, data: saved });
  } catch (err: any) {
    log.error("save settings failed: " + String(err));
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/user/settings?wallet=...
router.get("/settings", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "");
    if (!wallet) {
      return res
        .status(400)
        .json({ success: false, message: "wallet query required" });
    }

    const settings = await dbService.getUserSettings(wallet);

    // No saved settings yet is not an error — the frontend falls back to its
    // own in-store defaults when data is null.
    return res.json({ success: true, data: settings });
  } catch (err: any) {
    log.error("get user settings failed: " + String(err));
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
