import "server-only";

import { findGrantingSubscriptionSince, getSubscriptionsForProfile } from "@/db/queries/billing";
import type { BillingSubscription, Profile } from "@/db/schema";
import type { PlanId } from "@/lib/billing/plans";
import type { PaidTierId } from "@/lib/billing/pricing";
import {
  cancelSubscription as cancelInPaddle,
  createPortalSession,
  type ProrationMode,
  removeScheduledChange,
  updateSubscriptionPrice,
} from "@/lib/paddle/api";
import { createCheckoutBinding } from "@/lib/paddle/binding";
import { readPaddleConfig } from "@/lib/paddle/config";
import { ACCESS_STATUSES, paddleSubscriptionSchema } from "@/lib/paddle/webhook";

import { applySubscriptionState, PLAN_RANK } from "./paddleWebhook";

export type SubscriptionSummary = {
  id: string;
  plan: PlanId | null;
  status: string;
  /** Recurring price in minor units and its currency, as Paddle reported it */
  unitPrice: { amount: string; currencyCode: string } | null;
  currentPeriodEndsAt: Date | null;
  scheduledChange: { action: string; effectiveAt: Date } | null;
  /** Why the plan can't be switched right now; null when it can */
  changeBlockedBy: string | null;
};

export type BillingOverview = {
  plan: PlanId;
  subscription: SubscriptionSummary | null;
  /** Whether there's a Paddle customer to open the billing portal for */
  hasBillingAccount: boolean;
};

/** The subscription that matters: the best one granting access, else a paused one */
function pickSubscription(subscriptions: BillingSubscription[]): BillingSubscription | null {
  const granting = subscriptions
    .filter((s) => ACCESS_STATUSES.has(s.status))
    .sort((a, b) => (b.plan ? PLAN_RANK[b.plan] : -1) - (a.plan ? PLAN_RANK[a.plan] : -1));
  if (granting[0]) return granting[0];
  return subscriptions.filter((s) => s.status === "paused").sort((a, b) => +b.lastEventAt - +a.lastEventAt)[0] ?? null;
}

function changeBlockedBy(subscription: BillingSubscription): string | null {
  if (!subscription.plan) return "This subscription isn't on a current Scout plan.";
  if (subscription.status === "past_due") return "Update your payment method in Manage billing first.";
  if (subscription.status === "paused") return "Resume your subscription in Manage billing first.";
  const change = subscription.scheduledChange;
  if (change) {
    const when = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(change.effectiveAt));
    if (change.action === "cancel") return `Your subscription ends ${when}. Keep it first, then switch.`;
    if (change.action === "pause") return `Your subscription pauses ${when}. Change that in Manage billing first.`;
    if (change.action === "resume") return `Your subscription resumes ${when}. You can switch after that.`;
    return "Your subscription has a scheduled change. Manage it in Manage billing first.";
  }
  return null;
}

export async function getBillingOverview(profile: Pick<Profile, "id" | "plan">): Promise<BillingOverview> {
  const subscriptions = await getSubscriptionsForProfile(profile.id);
  const chosen = pickSubscription(subscriptions);
  return {
    plan: profile.plan,
    hasBillingAccount: subscriptions.length > 0,
    subscription: chosen && {
      id: chosen.paddleSubscriptionId,
      plan: chosen.plan,
      status: chosen.status,
      unitPrice: chosen.unitPrice,
      currentPeriodEndsAt: chosen.currentPeriodEndsAt,
      scheduledChange: chosen.scheduledChange
        ? { action: chosen.scheduledChange.action, effectiveAt: new Date(chosen.scheduledChange.effectiveAt) }
        : null,
      changeBlockedBy: changeBlockedBy(chosen),
    },
  };
}

/** A short-lived link to Paddle's customer portal for this user's subscriptions */
export async function openBillingPortal(profile: Pick<Profile, "id">): Promise<string | null> {
  const subscriptions = await getSubscriptionsForProfile(profile.id);
  if (subscriptions.length === 0) return null;
  const latest = [...subscriptions].sort((a, b) => +b.lastEventAt - +a.lastEventAt)[0];
  const active = subscriptions.filter((s) => s.status !== "canceled").map((s) => s.paddleSubscriptionId);
  return createPortalSession(latest.paddleCustomerId, active);
}

export type BillingResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** Applies a subscription entity Paddle returned from one of our own API calls */
async function applyFromApi(entity: unknown): Promise<void> {
  const state = paddleSubscriptionSchema.parse(entity);
  await applySubscriptionState(state, state.updated_at ? new Date(state.updated_at) : new Date(), null);
}

async function currentGranting(profileId: string): Promise<BillingSubscription | null> {
  const subscription = pickSubscription(await getSubscriptionsForProfile(profileId));
  return subscription && ACCESS_STATUSES.has(subscription.status) ? subscription : null;
}

/**
 * What the server allows before a checkout opens: the price comes from
 * Scout's configuration (never from the browser), and nobody who already
 * pays gets a second subscription. The webhook enforces the same rule.
 */
export async function prepareCheckout(
  profile: Pick<Profile, "id" | "plan" | "userId">,
  target: PaidTierId,
): Promise<BillingResult<{ priceId: string; binding: string }>> {
  const config = readPaddleConfig();
  if (!config.ok) return { ok: false, message: "Checkout isn't configured." };
  if (profile.plan === "internal") {
    return { ok: false, message: "Internal accounts aren't billed and can't subscribe." };
  }
  if (await currentGranting(profile.id)) {
    return { ok: false, message: "You already have a subscription. Switch plans instead of subscribing again." };
  }
  return {
    ok: true,
    priceId: config.config.priceIds[target],
    // Signed and expiring: the webhook links the subscription only to this account
    binding: createCheckoutBinding({ userId: profile.userId, tier: target }),
  };
}

/**
 * Starter ↔ Pro on the existing subscription, never a second one. Upgrades
 * charge the prorated difference now; downgrades take effect now and the
 * credit goes to the next bill. Paddle's response is applied right away; the
 * webhook that follows confirms the same state.
 */
export async function changePlan(profile: Pick<Profile, "id" | "plan">, target: PaidTierId): Promise<BillingResult<{ plan: PlanId }>> {
  const config = readPaddleConfig();
  if (!config.ok) return { ok: false, message: "Billing isn't configured." };

  const subscription = await currentGranting(profile.id);
  if (!subscription) return { ok: false, message: "You don't have an active subscription to change." };
  const blocked = changeBlockedBy(subscription);
  if (blocked) return { ok: false, message: blocked };
  if (subscription.plan === target) return { ok: false, message: "You're already on this plan." };

  const mode: ProrationMode =
    PLAN_RANK[target] > PLAN_RANK[subscription.plan!] ? "prorated_immediately" : "prorated_next_billing_period";
  await applyFromApi(await updateSubscriptionPrice(subscription.paddleSubscriptionId, config.config.priceIds[target], mode));
  return { ok: true, plan: target };
}

/** Cancels at the end of the billing period: the plan stays until then */
export async function cancelAtPeriodEnd(profile: Pick<Profile, "id">): Promise<BillingResult<{ endsAt: Date | null }>> {
  const subscription = await currentGranting(profile.id);
  if (!subscription) return { ok: false, message: "You don't have an active subscription." };
  if (subscription.scheduledChange?.action === "cancel") return { ok: false, message: "Your subscription is already set to end." };
  if (subscription.status === "past_due") {
    return { ok: false, message: "Your last payment failed. Cancel it in Manage billing." };
  }
  await applyFromApi(await cancelInPaddle(subscription.paddleSubscriptionId, "next_billing_period"));
  return { ok: true, endsAt: subscription.currentPeriodEndsAt };
}

/** Undoes a scheduled cancellation: the subscription renews as usual */
export async function keepSubscription(profile: Pick<Profile, "id">): Promise<BillingResult> {
  const subscription = await currentGranting(profile.id);
  if (subscription?.scheduledChange?.action !== "cancel") return { ok: false, message: "Your subscription isn't set to end." };
  await applyFromApi(await removeScheduledChange(subscription.paddleSubscriptionId));
  return { ok: true };
}

/** After checkout: has the verified webhook created the subscription yet? */
export async function checkoutConfirmation(
  profile: Pick<Profile, "id">,
  since: Date,
): Promise<{ status: "confirmed"; plan: PlanId | null } | { status: "pending" }> {
  const subscription = await findGrantingSubscriptionSince(profile.id, since);
  return subscription ? { status: "confirmed", plan: subscription.plan } : { status: "pending" };
}
