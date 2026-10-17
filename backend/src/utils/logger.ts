// backend/src/utils/logger.ts
import pino, { Logger } from "pino";

const isDev = process.env.NODE_ENV !== "production";

// Log level: LOG_LEVEL wins when set (debug | info | warn | error). The
// default is "info" everywhere — "debug" used to be the dev default, which
// printed every Blur pool event and every price probe to the terminal (dozens
// of lines a second) and made real warnings impossible to spot. Set
// LOG_LEVEL=debug in .env when you actually need the firehose.
const level = process.env.LOG_LEVEL?.trim() || "info";

// Pretty, colorized single-line output in dev; plain JSON in production
// (pm2 / log shippers parse it, and it is much cheaper to write).
const baseLogger = pino({
  name: "ArchAngel-Backend",
  level,
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            singleLine: true,
          },
        },
      }
    : {}),
});

/**
 * ✅ Namespaced module logger
 * @example const logger = getLogger("TradeRoute");
 */
export const getLogger = (name: string): Logger =>
  baseLogger.child({ module: name });

export default baseLogger;
