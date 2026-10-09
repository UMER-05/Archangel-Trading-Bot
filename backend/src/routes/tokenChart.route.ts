import express from "express";
import { getTokenChartData } from "../services/tokenChart.service.js";

const router = express.Router();

// GET /api/tokens/:mint/chart?tf=24h
router.get("/:mint/chart", async (req, res) => {
  const { mint } = req.params;
  const { tf } = req.query;
  if (!mint)
    return res
      .status(400)
      .json({ success: false, message: "Missing token mint" });
  try {
    // tf: 1h, 24h, 7d, 30d
    const data = await getTokenChartData(mint, (tf as string) || "24h");
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
