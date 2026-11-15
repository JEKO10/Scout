"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { requireProfile } from "@/lib/auth/session";
import { PaddleApiError, PaddleNotConfiguredError } from "@/lib/paddle/api";
import { changePlan, openBillingPortal } from "@/services/billing/account";

type ActionResult = { ok: true; url?: string; message?: string } | { ok: false; message: string };

function failure(error: unknown, fallback: string): ActionResult {
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

const targetSchema = z.enum(["starter", "pro"]);

/** Pricing → Switch plan, on the user's existing subscription */
export async function changePlanAction(target: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = targetSchema.safeParse(target);
  if (!parsed.success) return { ok: false, message: "Unknown plan." };
  try {
    const result = await changePlan(profile, parsed.data);
    if (!result.ok) return result;
    refresh();
    return { ok: true, message: `You're now on ${parsed.data === "pro" ? "Pro" : "Starter"}.` };
  } catch (error) {
    return failure(error, "Couldn't change your plan. Check Manage billing before trying again.");
  }
}
