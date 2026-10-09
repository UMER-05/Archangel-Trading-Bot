import nodemailer from "nodemailer";
import { getLogger } from "../../utils/logger.js";

const log = getLogger("email");

const EMAIL_FROM = process.env.ALERT_EMAIL_FROM;
const EMAIL_TO = process.env.ALERT_EMAIL_TO;

let transporter: nodemailer.Transporter | null = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send email alert (best-effort)
 */
export async function sendEmail(subject: string, html: string, text?: string) {
  try {
    if (!transporter || !EMAIL_FROM || !EMAIL_TO) {
      log.warn("Email transporter not configured, skipping email");
      return;
    }

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      text: text ?? html,
      html,
    });

    log.info("Email alert sent");
  } catch (err: any) {
    log.error("Failed to send email alert: " + (err?.message || err));
  }
}

export default { sendEmail };
