"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { updateProfileXHandle } from "@/db/queries/profiles";
import { requireProfile } from "@/lib/auth/session";
import { xHandleSchema } from "@/schemas/onboarding";
import { collectConnectedGrowthData } from "@/services/growth/collect";
import { disconnectX } from "@/services/x/oauthConnection";

const disconnectSchema = z.object({ deleteHistory: z.boolean() });

/** Revokes Scout's X tokens and removes the connection; optionally the private metric history too */
export async function disconnectXAction(input: { deleteHistory: boolean }): Promise<{ ok: boolean; message: string }> {
  const { profile } = await requireProfile();
  const parsed = disconnectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const { deletedReadings } = await disconnectX(profile.id, parsed.data);
  refresh();
  return {
    ok: true,
    message: parsed.data.deleteHistory
      ? `X disconnected. ${deletedReadings} stored metric readings deleted.`
      : "X disconnected. Metrics Scout already stored stay until you delete them.",
  };
}

/**
 * "Use @other instead": the profile's X handle becomes the account the user
 * just authorized. Ownership is checked again by the OAuth flow that follows;
 * stored posts of the previous account stay.
 */
export async function switchXHandleAction(handle: string): Promise<{ ok: boolean; message: string }> {
  const { profile } = await requireProfile();
  const parsed = xHandleSchema.safeParse(handle);
  if (!parsed.success) return { ok: false, message: "Invalid X handle." };
  await updateProfileXHandle(profile.id, parsed.data);
  return { ok: true, message: `Scout now uses @${parsed.data}. Connecting X…` };
}

/**
 * Day 37: the one-time import of the last 29 days (up to the plan's import
 * size), from the plan's X reads. Shown with its cost before the click.
 */
export async function importXHistoryAction(): Promise<{ ok: boolean; message: string }> {
  const { profile } = await requireProfile();
  const result = await collectConnectedGrowthData(profile, "import");
  if (result.ok) refresh();
  return result;
}
