import "server-only";

import { getSubscriptionsForProfile } from "@/db/queries/billing";
import type { BillingSubscription, Profile } from "@/db/schema";
import type { PlanId } from "@/lib/billing/plans";
import type { PaidTierId } from "@/lib/billing/pricing";
import { createPortalSession, type ProrationMode, updateSubscriptionPrice } from "@/lib/paddle/api";
import { readPaddleConfig } from "@/lib/paddle/config";
import { ACCESS_STATUSES, paddleSubscriptionSchema } from "@/lib/paddle/webhook";

import { applySubscription, PLAN_RANK } from "./paddleWebhook";

export type SubscriptionSummary = {
  id: string;
  plan: PlanId | null;
  status: string;
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
  if (subscription.scheduledChange) return "Your subscription has a scheduled change. Manage it in Manage billing first.";
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

export type ChangePlanResult = { ok: true; plan: PlanId } | { ok: false; message: string };

/**
 * Starter ↔ Pro on the existing subscription, never a second one. Upgrades
 * charge the prorated difference now; downgrades take effect now and the
 * credit goes to the next bill. Paddle's response is applied right away; the
 * webhook that follows confirms the same state.
 */
export async function changePlan(profile: Pick<Profile, "id" | "plan">, target: PaidTierId): Promise<ChangePlanResult> {
  const config = readPaddleConfig();
  if (!config.ok) return { ok: false, message: "Billing isn't configured." };

  const subscription = pickSubscription(await getSubscriptionsForProfile(profile.id));
  if (!subscription || !ACCESS_STATUSES.has(subscription.status)) {
    return { ok: false, message: "You don't have an active subscription to change." };
  }
  const blocked = changeBlockedBy(subscription);
  if (blocked) return { ok: false, message: blocked };
  if (subscription.plan === target) return { ok: false, message: "You're already on this plan." };

  const mode: ProrationMode =
    PLAN_RANK[target] > PLAN_RANK[subscription.plan!] ? "prorated_immediately" : "prorated_next_billing_period";
  const updated = paddleSubscriptionSchema.parse(
    await updateSubscriptionPrice(subscription.paddleSubscriptionId, config.config.priceIds[target], mode),
  );
  await applySubscription(updated, updated.updated_at ? new Date(updated.updated_at) : new Date());
  return { ok: true, plan: target };
}
