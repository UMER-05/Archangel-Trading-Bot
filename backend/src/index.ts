// backend/src/index.ts
import dotenv from "dotenv";
dotenv.config();

import http from "http";
import { Server as SocketIOServer } from "socket.io";

import { createApp } from "./app.js";
import { registerSocketHandlers } from "./routes/socket.route.js";

import dbService from "./services/db.service.js";
import { startPositionMonitor } from "./services/monitor.service.js";
import { startPriceAlertMonitor } from "./services/priceAlert.service.js";
import { startPnLBroadcaster } from "./services/pnlBroadcaster.service.js";
import { startDepositTracker } from "./services/depositTracker.service.js";
import { getLogger } from "./utils/logger.js";

const log = getLogger("index");
import { ENV } from "./utils/env.js";
import candidatePipelineService from "./services/candidatePipeline.service.js";
import { registerNativeExecutors } from "./services/execution/registerNativeExecutors.js";
import { startBlurStream } from "./services/blurStream.service.js";

// pino-pretty runs its transport in a worker thread in dev; log.error()
// immediately followed by process.exit() can race ahead of that flush and the
// message never reaches the terminal. flush() + a short grace delay (rather
// than relying solely on the flush callback, which isn't guaranteed to fire
// in every pino/transport combination) gives the message a real chance to land.
// This only *schedules* the exit — it does not halt execution, so every call
// site must `return` immediately after calling it.
function scheduleExit(code: number): void {
  log.flush();
  setTimeout(() => process.exit(code), 300);
}

// No process manager/supervisor is configured for this bot today — an
// unhandled error anywhere outside the try/catch-wrapped discovery loops
// would otherwise crash the whole process with zero warning and zero graceful
// shutdown. unhandledRejection is logged and the process is kept alive (most
// rejections here are recoverable, e.g. a stray fire-and-forget promise from
// a background loop). uncaughtException is logged then the process exits —
// continuing after a genuinely uncaught synchronous exception is unsafe for a
// bot that signs and sends real transactions, so failing loud and fast (with
// the flush guard above) is safer than limping on in an unknown state.
process.on("unhandledRejection", (reason: any) => {
  log.error(
    { err: reason?.stack ?? reason?.message ?? String(reason) },
    "🚨 Unhandled promise rejection (process kept alive)",
  );
});

process.on("uncaughtException", (err: Error) => {
  log.error(
    { err: err.stack ?? err.message },
    "🚨 Uncaught exception — exiting",
  );
  scheduleExit(1);
});

(async () => {
  try {
    await dbService.connect();
    log.info("✅ MongoDB connected");
  } catch (err: any) {
    log.error("❌ Failed to connect to DB: " + String(err));
    scheduleExit(1);
    return;
  }

  if (!ENV.FRONTEND_URL) {
    log.warn(
      "FRONTEND_URL is not set — CORS and the socket accept requests from ANY origin. Set it to your dashboard's URL in production.",
    );
  }

  const app = createApp();
  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: ENV.FRONTEND_URL || "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });
  // Route handlers pull this back out to broadcast after an HTTP-triggered
  // change — but inconsistently, some via req.app.get("io") (admin.route.ts,
  // stats.route.ts, trade.route.ts), others via req.app.locals.io
  // (config.route.ts, watchlist.route.ts, traderConfig.route.ts). Setting
  // both here covers every existing call site; without this, each lookup
  // silently resolved to undefined and the `io?.emit(...)` calls no-op with
  // no error anywhere.
  app.set("io", io);
  app.locals.io = io;
  registerSocketHandlers(io);

  // Start position monitor for tracking open trades
  startPositionMonitor(io);
  // Start price alert monitor for watchlist notifications
  startPriceAlertMonitor(io, { intervalMs: 60000 }); // Check every minute
  // Start P&L broadcaster for periodic portfolio updates
  startPnLBroadcaster(io, { intervalMs: 30000 }); // Broadcast every 30 seconds
  // Detect SOL deposited into each custodial wallet (see depositTracker.service.ts)
  startDepositTracker({ intervalMs: 60000 }, io);
  // Candidate discovery is event-driven, not polled: the Solami Blur stream
  // pushes every new pool over one outbound WebSocket, and each event runs
  // through the single linear pipeline in candidatePipeline.service.ts. Give
  // the pipeline the socket server first so it can emit progress events, then
  // start the stream. If SOLAMI_BLUR_API_KEY is unset the stream does not
  // start and NO discovery runs (startBlurStream logs that as an error).
  candidatePipelineService.setSocketIO(io);
  startBlurStream();
  log.info("🎣 Candidate pipeline ready (Blur stream-driven)");
  registerNativeExecutors();
  server.listen(ENV.PORT, () => {
    log.info(`⚡ Backend online → http://localhost:${ENV.PORT}`);
  });
})();
