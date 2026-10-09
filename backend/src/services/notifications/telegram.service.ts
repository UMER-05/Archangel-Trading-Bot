import axios from "axios";
import { getLogger } from "../../utils/logger.js";

const log = getLogger("telegram");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Send telegram message (best-effort)
 */
export async function sendTelegram(text: string) {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      log.warn("Telegram not configured, skipping message");
      return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      parse_mode: "Markdown",
      text,
      disable_web_page_preview: true,
    });
    log.info("Telegram alert sent");
  } catch (err: any) {
    log.error("Failed to send Telegram alert: " + (err?.message || err));
  }
}

export default { sendTelegram };
