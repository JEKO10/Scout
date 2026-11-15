import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// Day 23: which Scout account a checkout belongs to. The server issues a
// signed, expiring token when it allows a checkout; Paddle stores it in the
// subscription's custom_data; the webhook accepts only a valid one. A user
// can't open a checkout for somebody else's account by editing customData.

/** How long a checkout opened from Scout stays valid */
const BINDING_TTL_MS = 2 * 60 * 60_000;
/** Clock skew between Scout and Paddle we tolerate */
const SKEW_MS = 5 * 60_000;

export type CheckoutBinding = { userId: string; tier: "starter" | "pro" };

type Payload = { u: string; t: CheckoutBinding["tier"]; iat: number; exp: number };

function signingKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is not set: checkout bindings can't be signed");
  // A key of its own, derived from the app's secret: never the same bytes as token encryption
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64"), Buffer.alloc(0), "scout:paddle-checkout-binding:v1", 32));
}

function mac(data: string): string {
  return createHmac("sha256", signingKey()).update(data).digest("base64url");
}

export function createCheckoutBinding(binding: CheckoutBinding, now = new Date()): string {
  const payload: Payload = { u: binding.userId, t: binding.tier, iat: now.getTime(), exp: now.getTime() + BINDING_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `v1.${body}.${mac(`v1.${body}`)}`;
}

/**
 * The binding if its signature is valid and the checkout happened while it
 * was valid. `checkoutAt` is when Paddle created the subscription, not now:
 * a webhook retried days later still verifies.
 */
export function verifyCheckoutBinding(token: unknown, checkoutAt: Date): CheckoutBinding | null {
  if (typeof token !== "string") return null;
  const [version, body, signature] = token.split(".");
  if (version !== "v1" || !body || !signature) return null;
  const expected = Buffer.from(mac(`v1.${body}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.u !== "string" || (payload.t !== "starter" && payload.t !== "pro")) return null;
  const at = checkoutAt.getTime();
  if (at < payload.iat - SKEW_MS || at > payload.exp + SKEW_MS) return null;
  return { userId: payload.u, tier: payload.t };
}
