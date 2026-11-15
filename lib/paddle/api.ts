import "server-only";

import { z } from "zod";

import { readPaddleConfig } from "./config";

// Server-side Paddle API: customer portal sessions and plan changes. Uses the
// secret PADDLE_API_KEY, so it must never be imported from client code.

export class PaddleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export class PaddleNotConfiguredError extends Error {}

function connection(): { baseUrl: string; apiKey: string } {
  const config = readPaddleConfig();
  if (!config.ok) throw new PaddleNotConfiguredError(config.problems.join("; "));
  const apiKey = process.env.PADDLE_API_KEY;
  // Key prefixes are per environment; a live key never runs against sandbox and vice versa
  const prefix = config.config.environment === "sandbox" ? "pdl_sdbx_apikey_" : "pdl_live_apikey_";
  if (!apiKey?.startsWith(prefix)) {
    throw new PaddleNotConfiguredError(`PADDLE_API_KEY is missing or not a ${config.config.environment} key (${prefix}…)`);
  }
  return {
    baseUrl: config.config.environment === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com",
    apiKey,
  };
}

const errorSchema = z.object({ error: z.object({ code: z.string().optional(), detail: z.string().optional() }) });

async function request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
  const { baseUrl, apiKey } = connection();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(json);
    throw new PaddleApiError(
      parsed.success ? (parsed.data.error.detail ?? "Paddle request failed") : `Paddle request failed (${response.status})`,
      response.status,
      parsed.success ? (parsed.data.error.code ?? null) : null,
    );
  }
  return json;
}

const portalSchema = z.object({ data: z.object({ urls: z.object({ general: z.object({ overview: z.url() }) }) }) });

/**
 * A one-time link to Paddle's customer portal: cancel, payment method,
 * invoices. Authenticated for this customer only, valid for a short time.
 */
export async function createPortalSession(customerId: string, subscriptionIds: string[]): Promise<string> {
  const json = await request("POST", `/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
    subscription_ids: subscriptionIds,
  });
  return portalSchema.parse(json).data.urls.general.overview;
}

export type ProrationMode = "prorated_immediately" | "prorated_next_billing_period";

/** Swaps the subscription's price. Returns Paddle's updated subscription entity. */
export async function updateSubscriptionPrice(
  subscriptionId: string,
  priceId: string,
  prorationBillingMode: ProrationMode,
): Promise<unknown> {
  const json = await request("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    items: [{ price_id: priceId, quantity: 1 }],
    proration_billing_mode: prorationBillingMode,
  });
  return z.object({ data: z.unknown() }).parse(json).data;
}

/** Whether server-side Paddle calls can be made (key present and matching the environment) */
export function isPaddleApiConfigured(): boolean {
  try {
    connection();
    return true;
  } catch {
    return false;
  }
}

const entitySchema = z.object({ data: z.unknown() });

/** Paddle's current subscription entity: the authority when events arrive out of order */
export async function getSubscription(subscriptionId: string): Promise<unknown> {
  return entitySchema.parse(await request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`)).data;
}

/** Cancels at the end of the billing period (access continues until then), or immediately */
export async function cancelSubscription(
  subscriptionId: string,
  effectiveFrom: "next_billing_period" | "immediately",
): Promise<unknown> {
  const json = await request("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    effective_from: effectiveFrom,
  });
  return entitySchema.parse(json).data;
}

/** Removes a scheduled change, e.g. keeps a subscription that was set to cancel */
export async function removeScheduledChange(subscriptionId: string): Promise<unknown> {
  const json = await request("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId)}`, { scheduled_change: null });
  return entitySchema.parse(json).data;
}
