import "server-only";

import {
  getSubscriptionByPaddleId,
  getSubscriptionsForProfile,
  hasPaddleEvent,
  recordPaddleEvent,
  saveSubscriptionState,
} from "@/db/queries/billing";
import { getProfileById, getProfileByUserId } from "@/db/queries/profiles";
import type { BillingSubscription } from "@/db/schema";
import type { PlanId } from "@/lib/billing/plans";
import { cancelSubscription, getSubscription, isPaddleApiConfigured } from "@/lib/paddle/api";
import { verifyCheckoutBinding } from "@/lib/paddle/binding";
import { readPaddleConfig } from "@/lib/paddle/config";
import {
  ACCESS_STATUSES,
  paddleAdjustmentSchema,
  type PaddleEvent,
  type PaddleSubscription,
  paddleSubscriptionSchema,
  paddleTransactionSchema,
  revokesAccess,
} from "@/lib/paddle/webhook";

import { billingAlert } from "./alerts";

export type WebhookOutcome =
  | "applied"
  | "stale"
  | "unmatched"
  | "ignored"
  | "duplicate"
  | "duplicate_canceled"
  /** A full refund or chargeback ended the subscription's paid access */
  | "refund_canceled"
  /** A partial refund, credit or reversal: recorded and alerted, access unchanged */
  | "adjustment_noted";

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

type EventRecord = { eventId: string; eventType: string; occurredAt: Date };

/** The subscription an event is about: its own ID, or the transaction's subscription */
function subscriptionIdOf(event: PaddleEvent): string | null {
  if (event.event_type.startsWith("subscription.")) return paddleSubscriptionSchema.parse(event.data).id;
  if (event.event_type.startsWith("transaction.")) return paddleTransactionSchema.parse(event.data).subscription_id ?? null;
  return null;
}

/** Paddle's current state of a subscription and the moment it describes */
async function fetchCurrent(subscriptionId: string): Promise<{ state: PaddleSubscription; version: Date }> {
  const state = paddleSubscriptionSchema.parse(await getSubscription(subscriptionId));
  return { state, version: state.updated_at ? new Date(state.updated_at) : new Date() };
}

/**
 * Applies one verified Paddle event. Every subscription and transaction event
 * is reconciled against Paddle's current subscription (when the API key is
 * set), so the order events arrive in doesn't matter. Safe to receive twice.
 * Anything that can't be applied safely throws: Paddle then retries.
 */
export async function handlePaddleEvent(event: PaddleEvent): Promise<WebhookOutcome> {
  if (await hasPaddleEvent(event.event_id)) return "duplicate";
  const record: EventRecord = { eventId: event.event_id, eventType: event.event_type, occurredAt: new Date(event.occurred_at) };

  if (event.event_type.startsWith("adjustment.")) return handleAdjustment(event, record);

  const subscriptionId = subscriptionIdOf(event);
  if (!subscriptionId) {
    await recordPaddleEvent({ ...record, outcome: "ignored", profileId: null });
    return "ignored";
  }

  let current: { state: PaddleSubscription; version: Date };
  if (isPaddleApiConfigured()) {
    current = await fetchCurrent(subscriptionId);
  } else if (event.event_type.startsWith("subscription.")) {
    // Without an API key the event's own snapshot is used, ordered by its time
    console.warn("Paddle webhook: PADDLE_API_KEY not set, applying the event payload without reconciliation");
    current = { state: paddleSubscriptionSchema.parse(event.data), version: record.occurredAt };
  } else {
    await recordPaddleEvent({ ...record, outcome: "ignored", profileId: null });
    return "ignored";
  }

  return applySubscriptionState(current.state, current.version, record);
}

/**
 * Stores a subscription state (from a webhook or a Paddle API response) and
 * the plan it implies, atomically. A second subscription granting access to
 * the same user is canceled in Paddle at once instead of being stacked.
 */
export async function applySubscriptionState(
  incoming: PaddleSubscription,
  version: Date,
  event: EventRecord | null,
  outcomeOverride?: WebhookOutcome,
): Promise<WebhookOutcome> {
  let state = incoming;
  const existing = await getSubscriptionByPaddleId(state.id);

  // Who it belongs to: fixed once known; first from the signed binding the
  // server issued for the checkout. A plain userId (or anything else the
  // browser could write) is not accepted.
  let profileId = existing?.profileId ?? null;
  if (!profileId) {
    const checkoutAt = state.created_at ? new Date(state.created_at) : version;
    const binding = verifyCheckoutBinding(state.custom_data?.scoutBinding, checkoutAt);
    const owner = binding ? await getProfileByUserId(binding.userId) : undefined;
    if (!owner) {
      if (event) await recordPaddleEvent({ ...event, outcome: "unmatched", profileId: null });
      await billingAlert(
        "unmatched",
        `Subscription ${state.id} (customer ${state.customer_id}, ${state.status}) has no valid Scout account binding. Check it in Paddle; refund or link it by hand.`,
      );
      return "unmatched";
    }
    profileId = owner.id;
    const bought = planForPrice(state.items[0]?.price?.id);
    if (bought !== binding!.tier) {
      await billingAlert(
        "binding_mismatch",
        `Subscription ${state.id}: checkout was opened for ${binding!.tier}, Paddle has price ${state.items[0]?.price?.id ?? "none"}. The plan follows the price.`,
      );
    }
    if (owner.plan === "internal") {
      await billingAlert("internal_purchase", `Internal account ${owner.id} has subscription ${state.id}. Its plan stays internal; cancel the subscription in Paddle.`);
    }
  }

  if (existing && existing.lastEventAt > version) {
    if (event) await recordPaddleEvent({ ...event, outcome: "stale", profileId });
    return "stale";
  }

  let outcome: WebhookOutcome = "applied";
  let others = (await getSubscriptionsForProfile(profileId)).filter((s) => s.paddleSubscriptionId !== state.id);
  if (ACCESS_STATUSES.has(state.status) && others.some((s) => ACCESS_STATUSES.has(s.status))) {
    others = await refreshGranting(others);
    if (others.some((s) => ACCESS_STATUSES.has(s.status))) {
      // Still a second paid subscription: the newer one is canceled, the first kept
      if (!isPaddleApiConfigured()) {
        throw new Error(`Second active subscription ${state.id} for profile ${profileId}; PADDLE_API_KEY is needed to cancel it`);
      }
      state = paddleSubscriptionSchema.parse(await cancelSubscription(state.id, "immediately"));
      version = state.updated_at ? new Date(state.updated_at) : new Date();
      outcome = "duplicate_canceled";
      await billingAlert(
        "duplicate_canceled",
        `Canceled duplicate subscription ${state.id} of profile ${profileId}; the first one is kept. Refund it in Paddle if it was charged.`,
      );
    }
  }

  const values = subscriptionValues(state, profileId, version);
  const profile = await getProfileById(profileId);
  const plan = effectivePlan([...others, values]);
  const planChanges = profile && profile.plan !== "internal" && profile.plan !== plan;

  await saveSubscriptionState({
    subscription: values,
    profilePlan: planChanges ? { profileId, plan } : null,
    event: event && { ...event, outcome: outcomeOverride ?? outcome, profileId },
  });
  return outcomeOverride ?? outcome;
}

/** Re-reads the user's other "active" subscriptions from Paddle before treating a new one as a duplicate */
async function refreshGranting(subscriptions: BillingSubscription[]): Promise<BillingSubscription[]> {
  if (!isPaddleApiConfigured()) return subscriptions;
  return Promise.all(
    subscriptions.map(async (subscription) => {
      if (!ACCESS_STATUSES.has(subscription.status)) return subscription;
      const { state, version } = await fetchCurrent(subscription.paddleSubscriptionId);
      if (state.status === subscription.status) return subscription;
      // Its own webhook hasn't arrived yet: store what Paddle says now
      const values = subscriptionValues(state, subscription.profileId, version);
      await saveSubscriptionState({ subscription: values, profilePlan: null, event: null });
      return { ...subscription, ...values };
    }),
  );
}

function subscriptionValues(state: PaddleSubscription, profileId: string, version: Date) {
  const price = state.items[0]?.price ?? null;
  return {
    profileId,
    paddleSubscriptionId: state.id,
    paddleCustomerId: state.customer_id,
    status: state.status,
    priceId: price?.id ?? null,
    plan: planForPrice(price?.id),
    unitPrice: price?.unit_price ? { amount: price.unit_price.amount, currencyCode: price.unit_price.currency_code } : null,
    currentPeriodEndsAt: state.current_billing_period ? new Date(state.current_billing_period.ends_at) : null,
    scheduledChange: state.scheduled_change
      ? { action: state.scheduled_change.action, effectiveAt: state.scheduled_change.effective_at }
      : null,
    lastEventAt: version,
  };
}

/**
 * profiles.plan follows the user's subscriptions: the best plan among those
 * still granting access, Free when none does. (Internal accounts are skipped
 * by the caller and by the write itself.)
 */
function effectivePlan(subscriptions: Pick<BillingSubscription, "plan" | "status">[]): PlanId {
  let plan: PlanId = "free";
  for (const subscription of subscriptions) {
    if (subscription.plan && ACCESS_STATUSES.has(subscription.status) && PLAN_RANK[subscription.plan] > PLAN_RANK[plan]) {
      plan = subscription.plan;
    }
  }
  return plan;
}

/**
 * Refunds, credits and chargebacks. A full approved refund or a chargeback
 * ends the subscription's paid access at once: the subscription is canceled
 * in Paddle and the plan follows. Everything else is recorded and alerted.
 */
async function handleAdjustment(event: PaddleEvent, record: EventRecord): Promise<WebhookOutcome> {
  const adjustment = paddleAdjustmentSchema.parse(event.data);
  const describe = `${adjustment.action} ${adjustment.type ?? ""} ${adjustment.status} (adjustment ${adjustment.id}, transaction ${adjustment.transaction_id ?? "none"}, subscription ${adjustment.subscription_id ?? "none"})`;
  const existing = adjustment.subscription_id ? await getSubscriptionByPaddleId(adjustment.subscription_id) : undefined;

  if (!revokesAccess(adjustment) || !adjustment.subscription_id) {
    // Pending refunds aren't money back yet; their approval arrives as adjustment.updated
    const noteworthy = adjustment.status !== "pending_approval";
    if (noteworthy) await billingAlert("adjustment", describe);
    await recordPaddleEvent({ ...record, outcome: noteworthy ? "adjustment_noted" : "ignored", profileId: existing?.profileId ?? null });
    return noteworthy ? "adjustment_noted" : "ignored";
  }

  if (!isPaddleApiConfigured()) {
    // Can't confirm or cancel safely: fail, so Paddle retries once the key is set
    throw new Error(`Refund/chargeback for ${adjustment.subscription_id} needs PADDLE_API_KEY to end access`);
  }
  let { state, version } = await fetchCurrent(adjustment.subscription_id);
  if (ACCESS_STATUSES.has(state.status)) {
    state = paddleSubscriptionSchema.parse(await cancelSubscription(state.id, "immediately"));
    version = state.updated_at ? new Date(state.updated_at) : new Date();
  }
  await billingAlert("refund_canceled", `${describe}: subscription canceled, paid access ended.`);
  return applySubscriptionState(state, version, record, "refund_canceled");
}
