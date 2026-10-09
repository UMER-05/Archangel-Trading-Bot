// backend/src/utils/logger.ts
import pino, { Logger } from "pino";

const isDev = process.env.NODE_ENV !== "production";

// ✅ Base config (JSON logs in production)
const baseLogger = pino({
  name: "ArchAngel-Backend",
  level: isDev ? "debug" : "info",
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
