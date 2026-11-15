import "server-only";

import {
  getSubscriptionByPaddleId,
  getSubscriptionsForProfile,
  hasPaddleEvent,
  recordPaddleEvent,
  setProfilePlan,
  upsertSubscription,
} from "@/db/queries/billing";
import { getProfileById, getProfileByUserId } from "@/db/queries/profiles";
import type { PlanId } from "@/lib/billing/plans";
import { readPaddleConfig } from "@/lib/paddle/config";
import {
  ACCESS_STATUSES,
  type PaddleEvent,
  type PaddleSubscription,
  paddleSubscriptionSchema,
} from "@/lib/paddle/webhook";

export type WebhookOutcome = "applied" | "stale" | "unmatched" | "ignored" | "duplicate";

/** Plans in order of what they include; the best active subscription wins */
export const PLAN_RANK: Record<PlanId, number> = { free: 0, starter: 1, pro: 2, internal: 3 };

/** The Scout plan a Paddle price buys, by the configured price IDs */
export function planForPrice(priceId: string | null | undefined): PlanId | null {
  const config = readPaddleConfig();
  if (!config.ok || !priceId) return null;
  if (priceId === config.config.priceIds.starter) return "starter";
  if (priceId === config.config.priceIds.pro) return "pro";
  return null;
}

/**
 * Applies one verified Paddle event. Safe to receive twice (Paddle retries,
 * dashboard replays) and out of order: each subscription keeps the time of
 * the newest event applied, and older events don't overwrite it.
 */
export async function handlePaddleEvent(event: PaddleEvent): Promise<WebhookOutcome> {
  if (await hasPaddleEvent(event.event_id)) return "duplicate";

  let outcome: WebhookOutcome = "ignored";
  let profileId: string | null = null;
  if (event.event_type.startsWith("subscription.")) {
    const subscription = paddleSubscriptionSchema.parse(event.data);
    ({ outcome, profileId } = await applySubscription(subscription, new Date(event.occurred_at)));
  }
  // transaction.* events: recorded only; the subscription events carry the state

  await recordPaddleEvent({
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: new Date(event.occurred_at),
    profileId,
    outcome,
  });
  return outcome;
}

/** Stores Paddle's subscription state (from a webhook or an API response) and syncs the plan */
export async function applySubscription(
  subscription: PaddleSubscription,
  occurredAt: Date,
): Promise<{ outcome: WebhookOutcome; profileId: string | null }> {
  const existing = await getSubscriptionByPaddleId(subscription.id);

  // Who it belongs to: fixed once known; first from the userId the checkout sent
  let profileId = existing?.profileId ?? null;
  if (!profileId) {
    const userId = subscription.custom_data?.userId;
    const profile = typeof userId === "string" ? await getProfileByUserId(userId) : undefined;
    if (!profile) return { outcome: "unmatched", profileId: null };
    profileId = profile.id;
  }

  if (existing && existing.lastEventAt > occurredAt) return { outcome: "stale", profileId };

  const priceId = subscription.items[0]?.price?.id ?? null;
  await upsertSubscription({
    profileId,
    paddleSubscriptionId: subscription.id,
    paddleCustomerId: subscription.customer_id,
    status: subscription.status,
    priceId,
    plan: planForPrice(priceId),
    currentPeriodEndsAt: subscription.current_billing_period ? new Date(subscription.current_billing_period.ends_at) : null,
    scheduledChange: subscription.scheduled_change
      ? { action: subscription.scheduled_change.action, effectiveAt: subscription.scheduled_change.effective_at }
      : null,
    lastEventAt: occurredAt,
  });

  await syncProfilePlan(profileId);
  return { outcome: "applied", profileId };
}

/**
 * profiles.plan follows the user's subscriptions: the best plan among those
 * still granting access, Free when none does. Internal accounts are never
 * changed by billing.
 */
export async function syncProfilePlan(profileId: string): Promise<void> {
  const profile = await getProfileById(profileId);
  if (!profile || profile.plan === "internal") return;

  const subscriptions = await getSubscriptionsForProfile(profileId);
  let plan: PlanId = "free";
  for (const subscription of subscriptions) {
    if (subscription.plan && ACCESS_STATUSES.has(subscription.status) && PLAN_RANK[subscription.plan] > PLAN_RANK[plan]) {
      plan = subscription.plan;
    }
  }
  if (plan === profile.plan) return;
  // The chosen auto-scan interval is kept: the scheduler uses it only while
  // the plan offers it (autoScanInterval), so it returns after an upgrade back
  await setProfilePlan(profileId, plan);
}
