import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encryption at rest for third-party credentials (Slack bot tokens; later
// Telegram and others). AES-256-GCM with a random IV per value; the auth tag
// makes a tampered value fail to decrypt instead of decrypting to garbage.
// Stored as "v1.<iv>.<tag>.<ciphertext>", each part base64url.

const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set.");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  }
  return bytes;
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), encrypted]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptToken(stored: string): string {
  const [version, iv, tag, encrypted] = stored.split(".");
  if (version !== VERSION || !iv || !tag || !encrypted) {
    throw new Error("Unrecognized encrypted token format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
