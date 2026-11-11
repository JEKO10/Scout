"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { updateAutoScan } from "@/db/queries/profiles";
import { requireProfile } from "@/lib/auth/session";
import { PLANS } from "@/lib/billing/plans";

const settingsSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().positive(),
});

/** Settings: Automatic Scout on/off and how often, within the user's plan. */
export async function setAutoScoutAction(
  settings: z.input<typeof settingsSchema>,
): Promise<{ ok: boolean; message: string }> {
  const { profile } = await requireProfile();
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) return { ok: false, message: "Check the settings." };

  const { intervalsMinutes } = PLANS[profile.plan].autoScan;
  if (!intervalsMinutes.includes(parsed.data.intervalMinutes)) {
    return { ok: false, message: "Your plan doesn't offer that frequency." };
  }
  await updateAutoScan(profile.id, parsed.data);
  refresh();
  return {
    ok: true,
    message: parsed.data.enabled
      ? "Automatic Scout is on. The first scan runs within a few minutes."
      : "Automatic Scout is off.",
  };
}
