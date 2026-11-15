import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * Paddle-Signature: "ts=1671552777;h1=<hex>" (several h1 while a secret is
 * being rotated). The signed payload is `${ts}:${rawBody}`, HMAC-SHA256 with
 * the destination's secret key. The raw body must be used as received.
 */
export function verifyPaddleSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  now: Date = new Date(),
  toleranceSeconds = 300,
): boolean {
  if (!header) return false;
  let ts: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(";")) {
    const [key, value] = part.split("=", 2).map((s) => s.trim());
    if (key === "ts") ts = value;
    else if (key === "h1" && value) signatures.push(value);
  }
  if (!ts || !/^\d+$/.test(ts) || signatures.length === 0) return false;
  // Old signatures are refused: a captured request can't be replayed later
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest();
  return signatures.some((signature) => {
    if (!/^[0-9a-f]+$/i.test(signature)) return false;
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export const paddleEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.iso.datetime({ offset: true }),
  data: z.unknown(),
});

export type PaddleEvent = z.infer<typeof paddleEventSchema>;

/** The parts of Paddle's subscription entity Scout uses */
export const paddleSubscriptionSchema = z.object({
  id: z.string().startsWith("sub_"),
  status: z.string().min(1),
  customer_id: z.string().min(1),
  custom_data: z.record(z.string(), z.unknown()).nullish(),
  items: z
    .array(
      z.object({
        price: z
          .object({
            id: z.string(),
            unit_price: z.object({ amount: z.string(), currency_code: z.string() }).nullish(),
          })
          .nullish(),
      }),
    )
    .default([]),
  current_billing_period: z.object({ ends_at: z.string() }).nullish(),
  scheduled_change: z.object({ action: z.string(), effective_at: z.string() }).nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type PaddleSubscription = z.infer<typeof paddleSubscriptionSchema>;

/** transaction.* events: only the link to their subscription matters */
export const paddleTransactionSchema = z.object({ subscription_id: z.string().nullish() });

/** adjustment.* events: refunds, credits and chargebacks */
export const paddleAdjustmentSchema = z.object({
  id: z.string(),
  action: z.string(),
  type: z.string().nullish(),
  status: z.string(),
  subscription_id: z.string().nullish(),
  transaction_id: z.string().nullish(),
});

export type PaddleAdjustment = z.infer<typeof paddleAdjustmentSchema>;

/**
 * Money given back in full, or taken back by the bank: the subscription's
 * paid access ends. Partial refunds and credits keep it (they're alerted).
 */
export function revokesAccess(adjustment: PaddleAdjustment): boolean {
  if (adjustment.action === "chargeback") return true;
  return adjustment.action === "refund" && adjustment.type === "full" && adjustment.status === "approved";
}

/** Statuses during which the subscriber keeps the paid plan */
export const ACCESS_STATUSES = new Set(["active", "trialing", "past_due"]);
