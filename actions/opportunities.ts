"use server";

import { z } from "zod";

import { setOpportunityStatus } from "@/db/queries/opportunities";
import { requireProfile } from "@/lib/auth/session";

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
