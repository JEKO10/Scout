"use server";

import { refresh } from "next/cache";

import { requireProfile, requireUser } from "@/lib/auth/session";
import { XApiRequestError } from "@/lib/x/client";
import type { NormalizedProfile } from "@/lib/x/types";
import { xHandleSchema } from "@/schemas/onboarding";
import { lookupXHandle } from "@/services/x/lookupHandle";
import { syncXAccount } from "@/services/x/syncAccount";

export type XHandleLookup =
  | { status: "found"; profile: NormalizedProfile }
  | { status: "not_found" | "invalid" }
  | { status: "error"; message: string };

/** Powers the handle picker; signed-in only, since every lookup is billed. */
export async function lookupXHandleAction(
  handle: string,
): Promise<XHandleLookup> {
  await requireUser();

  const parsed = xHandleSchema.safeParse(handle);
  if (!parsed.success) return { status: "invalid" };

  try {
    const profile = await lookupXHandle(parsed.data);
    return profile ? { status: "found", profile } : { status: "not_found" };
  } catch (error) {
    console.error("X handle lookup failed", error);
    return {
      status: "error",
      message:
        error instanceof XApiRequestError && error.status === 429
          ? "X is rate limiting lookups. Try again shortly."
          : "Couldn't reach X to check this handle.",
    };
  }
}

export type SyncXState = {
  status: "idle" | "success" | "error";
  message?: string;
};

const minuteFormat = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit",
});

export async function syncXAccountAction(): Promise<SyncXState> {
  const { profile } = await requireProfile();

  try {
    const result = await syncXAccount(profile.id);

    if (result.status === "no_handle") {
      return { status: "error", message: "Add your X handle first." };
    }
    if (result.status === "not_found") {
      return {
        status: "error",
        message: `We couldn't find @${result.handle} on X. Check the handle in settings.`,
      };
    }

    refresh();
    return {
      status: "success",
      message: `${result.postCount} posts imported.`,
    };
  } catch (error) {
    console.error("X sync failed", error);

    if (error instanceof XApiRequestError && error.status === 429) {
      const retryAt = error.rateLimitResetAt
        ? ` after ${minuteFormat.format(error.rateLimitResetAt)}`
        : " in a few minutes";
      return {
        status: "error",
        message: `X is rate limiting requests. Try again${retryAt}.`,
      };
    }
    return {
      status: "error",
      message: "We couldn't reach X right now. Try again in a moment.",
    };
  }
}
