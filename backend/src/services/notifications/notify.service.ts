// backend/src/services/notify.service.ts
import { sendTelegram } from "./telegram.service.js";
import { sendEmail } from "./email.service.js";

/**
 * Convenience: notify on trade execution
 */
export async function notifyTrade(trade: {
  id: string;
  type: "buy" | "sell";
  token: string;
  amountSol: number;
  price?: number;
  pnl?: number;
  signature?: string | null;
  simulated?: boolean;
}) {
  const title = `${
    trade.simulated ? "SIM" : "LIVE"
  } ${trade.type.toUpperCase()} - ${trade.token}`;
  const pct =
    typeof trade.pnl === "number" ? `${(trade.pnl * 100).toFixed(2)}%` : "—";
  const text = `${title}
Amount: ${trade.amountSol} SOL
Price: ${trade.price ?? "—"}
PnL: ${pct}
Signature: ${trade.signature ?? "—"}`;

  // send Telegram + email in background
  sendTelegram(`\`${title}\`\n\`\`\`\n${text}\n\`\`\``).catch(() => {});
  sendEmail(`${title}`, `<pre>${text}</pre>`).catch(() => {});
}

/**
 * Convenience: notify on errors
 */
export async function notifyError(ctx: {
  source?: string;
  message: string;
  details?: any;
}) {
  const subject = `ArchAngel Error${ctx.source ? " — " + ctx.source : ""}`;
  const body = `Error: ${ctx.message}\n\nDetails: ${JSON.stringify(
    ctx.details ?? {},
    null,
    2
  )}`;
  sendTelegram(`⚠️ *${subject}*\n\`\`\`\n${body}\n\`\`\``).catch(() => {});
  sendEmail(subject, `<pre>${body}</pre>`).catch(() => {});
}

// Re-export for convenience
export { sendTelegram, sendEmail };

export default {
  sendTelegram,
  sendEmail,
  notifyTrade,
  notifyError,
};
