"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { getProfileByUserId } from "@/db/queries/profiles";
import { getOptionalUser, requireProfile } from "@/lib/auth/session";
import { PLANS } from "@/lib/billing/plans";
import { PaddleApiError, PaddleNotConfiguredError } from "@/lib/paddle/api";
import {
  cancelAtPeriodEnd,
  changePlan,
  checkoutConfirmation,
  keepSubscription,
  openBillingPortal,
  prepareCheckout,
} from "@/services/billing/account";

type ActionResult = { ok: true; url?: string; message?: string } | { ok: false; message: string };

function failure(error: unknown, fallback: string): { ok: false; message: string } {
  if (error instanceof PaddleNotConfiguredError) {
    console.error("Paddle API not configured:", error.message);
    return { ok: false, message: "Billing management isn't available right now." };
  }
  if (error instanceof PaddleApiError) {
    console.error(`Paddle API error ${error.status} ${error.code ?? ""}: ${error.message}`);
    return { ok: false, message: fallback };
  }
  console.error(fallback, error);
  return { ok: false, message: fallback };
}

const tierSchema = z.enum(["starter", "pro"]);

/**
 * Before the Paddle overlay opens: the server picks the price and refuses a
 * second subscription. The browser only passes which tier was clicked.
 */
export async function prepareCheckoutAction(
  tier: string,
): Promise<{ ok: true; priceId: string; email: string; binding: string } | { ok: false; message: string }> {
  const parsed = tierSchema.safeParse(tier);
  if (!parsed.success) return { ok: false, message: "Unknown plan." };
  const { user, profile } = await requireProfile();
  const result = await prepareCheckout(profile, parsed.data);
  if (!result.ok) return result;
  return { ok: true, priceId: result.priceId, email: user.email, binding: result.binding };
}

/** Settings → Manage billing: a fresh, short-lived Paddle portal link */
export async function openBillingPortalAction(): Promise<ActionResult> {
  const { profile } = await requireProfile();
  try {
    const url = await openBillingPortal(profile);
    if (!url) return { ok: false, message: "There's no billing account yet. Subscribe to a plan first." };
    return { ok: true, url };
  } catch (error) {
    return failure(error, "Couldn't open billing. Try again in a moment.");
  }
}

/** Pricing → Switch plan, on the user's existing subscription */
export async function changePlanAction(target: string): Promise<ActionResult> {
  const parsed = tierSchema.safeParse(target);
  if (!parsed.success) return { ok: false, message: "Unknown plan." };
  const { profile } = await requireProfile();
  try {
    const result = await changePlan(profile, parsed.data);
    if (!result.ok) return result;
    refresh();
    return { ok: true, message: `You're now on ${PLANS[parsed.data].label}.` };
  } catch (error) {
    return failure(error, "Couldn't change your plan. Check Manage billing before trying again.");
  }
}

/** Settings → Cancel subscription: ends at the close of the billing period */
export async function cancelSubscriptionAction(): Promise<ActionResult> {
  const { profile } = await requireProfile();
  try {
    const result = await cancelAtPeriodEnd(profile);
    if (!result.ok) return result;
    refresh();
    return { ok: true, message: "Your subscription is canceled. You keep your plan until the end of this billing period." };
  } catch (error) {
    return failure(error, "Couldn't cancel. Try again, or use Manage billing.");
  }
}

/** Settings → Keep subscription: undoes a scheduled cancellation */
export async function keepSubscriptionAction(): Promise<ActionResult> {
  const { profile } = await requireProfile();
  try {
    const result = await keepSubscription(profile);
    if (!result.ok) return result;
    refresh();
    return { ok: true, message: "Your subscription will renew as usual." };
  } catch (error) {
    return failure(error, "Couldn't keep your subscription. Try again, or use Manage billing.");
  }
}

/** /checkout/success polls this until the verified webhook has created the subscription */
export async function checkoutStatusAction(sinceIso: string): Promise<
  { status: "confirmed"; planLabel: string | null } | { status: "pending" } | { status: "signed_out" }
> {
  const since = new Date(sinceIso);
  if (Number.isNaN(+since)) return { status: "pending" };
  const user = await getOptionalUser();
  if (!user) return { status: "signed_out" };
  const profile = await getProfileByUserId(user.id);
  if (!profile) return { status: "pending" };
  const result = await checkoutConfirmation(profile, since);
  return result.status === "confirmed"
    ? { status: "confirmed", planLabel: result.plan ? PLANS[result.plan].label : null }
    : result;
}
