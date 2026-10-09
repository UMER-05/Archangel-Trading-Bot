// backend/src/utils/walletEncryption.ts
//
// AES-256-GCM encryption for per-user hot-wallet private keys at rest.
// WALLET_ENCRYPTION_KEY must be a 64-char hex string (32 bytes) and must
// live somewhere separate from routine app config — it is the single key
// that protects every user's custodied funds. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Losing this key makes every stored hot wallet permanently unrecoverable;
// rotating it requires re-encrypting every stored ciphertext.
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard nonce size

function getKey(): Buffer {
  const hex = process.env.WALLET_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY is not set — required to encrypt/decrypt custodied wallet keys"
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
  }
  return key;
}

/**
 * Encrypts a UTF-8 plaintext (e.g. a base58 secret key) into a single
 * self-contained string: "iv:authTag:ciphertext", all hex-encoded.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(
    ":"
  );
}

export function decryptSecret(payload: string): string {
  const key = getKey();
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted wallet payload");
  }
  const [ivHex, authTagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(authTagHex!, "hex");
  const data = Buffer.from(dataHex!, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}
