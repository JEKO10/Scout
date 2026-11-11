"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { setOpportunityStatus, surfaceScoredCandidates } from "@/db/queries/opportunities";
import { updateProfileByUserId } from "@/db/queries/profiles";
import { requireProfile } from "@/lib/auth/session";
import { OPPORTUNITY_SENSITIVITIES, surfaceThreshold } from "@/lib/scout/sensitivity";
import { MAX_POST_AGE_DAYS } from "@/services/scout/filters";

const statusSchema = z.object({
  opportunityId: z.uuid(),
  // "replied" is set by the Day 11 Reply Engine, not from the feed
  status: z.enum(["new", "saved", "dismissed"]),
});

export async function setOpportunityStatusAction(
  opportunityId: string,
  status: "new" | "saved" | "dismissed",
): Promise<{ ok: boolean }> {
  const { profile } = await requireProfile();
  const parsed = statusSchema.safeParse({ opportunityId, status });
  if (!parsed.success) return { ok: false };

  const ok = await setOpportunityStatus(
    profile.id,
    parsed.data.opportunityId,
    parsed.data.status,
  );
  // No refresh(): the card keeps its own state, so a dismissed card stays
  // on screen with Undo instead of vanishing from the filtered list
  return { ok };
}

const sensitivitySchema = z.enum(OPPORTUNITY_SENSITIVITIES);

/**
 * Settings: Fewer / Balanced / More. A lower threshold also brings in recent
 * posts Scout already scored that pass it now; a higher one applies to new
 * scans and leaves the current feed as it is.
 */
export async function setOpportunitySensitivityAction(
  value: string,
): Promise<{ ok: boolean; message: string }> {
  const { user, profile } = await requireProfile();
  const sensitivity = sensitivitySchema.safeParse(value);
  if (!sensitivity.success) return { ok: false, message: "Pick Fewer, Balanced or More." };

  await updateProfileByUserId(user.id, { opportunitySensitivity: sensitivity.data });
  const added = await surfaceScoredCandidates(
    profile.id,
    surfaceThreshold(sensitivity.data),
    new Date(Date.now() - MAX_POST_AGE_DAYS * 86_400_000),
  );
  refresh();
  return {
    ok: true,
    message: added
      ? `Saved. ${added} more ${added === 1 ? "opportunity" : "opportunities"} from recent scans.`
      : "Saved. It applies from your next scan.",
  };
}
