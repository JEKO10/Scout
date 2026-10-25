"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { setCandidateLabel } from "@/db/queries/scoutCandidates";
import { requireProfile } from "@/lib/auth/session";

const labelSchema = z.object({
  candidateId: z.uuid(),
  label: z.enum(["yes", "maybe", "no"]).nullable(),
});

/** Saves the user's blind YES / MAYBE / NO for the ranking check. */
export async function setCandidateLabelAction(
  candidateId: string,
  label: "yes" | "maybe" | "no" | null,
): Promise<void> {
  const { profile } = await requireProfile();
  const parsed = labelSchema.parse({ candidateId, label });
  await setCandidateLabel(profile.id, parsed.candidateId, parsed.label);
  refresh();
}
