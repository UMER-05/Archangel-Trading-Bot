// backend/src/app.ts
// Pure Express app construction — zero side effects (no DB connect, no HTTP
// listen, no background services started). Split out of index.ts so tests
// can import createApp() without also triggering index.ts's bootstrap IIFE,
// which used to connect to the real MongoDB, bind a real port, and start
// live Jupiter discovery polling as an unavoidable side effect of the import.
import dotenv from "dotenv";
dotenv.config();

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";

import tradeRoutes from "./routes/trade.route.js";
import statsRoutes from "./routes/stats.route.js";
import tokensRoutes from "./routes/tokens.route.js";
import tokenChartRoute from "./routes/tokenChart.route.js";
import positionsRoutes from "./routes/positions.route.js";
import watchlistRoutes from "./routes/watchlist.route.js";
import pnlRoutes from "./routes/pnl.route.js";
import cacheRoutes from "./routes/cache.route.js";
import configRoutes from "./routes/config.route.js";
import traderConfigRoutes from "./routes/traderConfig.route.js";
import adminRoutes from "./routes/admin.route.js";
import userRoutes from "./routes/user.route.js";
import oldTokensRoute from "./routes/oldTokens.route.js";
import userWalletRoute from "./routes/userWallet.route.js";

import dbService from "./services/db.service.js";
import { ENV } from "./utils/env.js";

export const createApp = () => {
  const app = express();
  app.use(
    cors({
      origin: ENV.FRONTEND_URL || "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(express.json());
  app.get("/", (_, res) =>
    res.json({ message: "🚀 ArchAngel Backend Running" }),
  );
  app.get("/health", (_, res) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || "development",
    });
  });
  app.get("/ready", async (_, res) => {
    try {
      const dbConnected = await dbService
        .connect()
        .then(() => true)
        .catch(() => false);
      if (dbConnected) {
        res.status(200).json({
          status: "ready",
          timestamp: new Date().toISOString(),
          database: "connected",
        });
      } else {
        res.status(503).json({
          status: "not ready",
          timestamp: new Date().toISOString(),
          database: "disconnected",
        });
      }
    } catch (error) {
      res.status(503).json({
        status: "not ready",
        timestamp: new Date().toISOString(),
        error: "Health check failed",
      });
    }
  });
  app.use("/api/trade", tradeRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/tokens", tokensRoutes);
  app.use("/api/tokens", tokenChartRoute);
  app.use("/api/positions", positionsRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/watchlist", watchlistRoutes);
  app.use("/api/pnl", pnlRoutes);
  app.use("/api/cache", cacheRoutes);
  app.use("/api/config", configRoutes);
  app.use("/api/trader-config", traderConfigRoutes);
  app.use("/api/old-tokens", oldTokensRoute);
  app.use("/api/user-wallet", userWalletRoute);

  // Unknown /api routes answer in JSON like everything else. Express's default
  // 404 is an HTML page ("Cannot POST /api/..."), which the dashboard's fetch
  // helper can only report as "Invalid JSON response" — hiding the real cause,
  // most often a dashboard that is newer than the backend actually running.
  app.use("/api", (req, res) => {
    res.status(404).json({
      success: false,
      error: `No such API route: ${req.method} ${req.originalUrl} — the backend may be out of date; restart it after updating.`,
    });
  });

  // Errors raised outside a route's own try/catch (e.g. a malformed JSON
  // body) are also answered in JSON, not as an HTML error page.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === "number" ? err.status : 500;
    res.status(status).json({
      success: false,
      error:
        err?.type === "entity.parse.failed"
          ? "Request body isn't valid JSON"
          : status >= 500
            ? "Internal server error"
            : err?.message || "Request failed",
    });
  });

  return app;
};
