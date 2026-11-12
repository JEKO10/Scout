"use server";

import { z } from "zod";

import { rateMissedCandidate } from "@/db/queries/missedPosts";
import { MISS_RATINGS } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";

const schema = z.object({
  candidateId: z.uuid(),
  rating: z.enum(MISS_RATINGS),
  sample: z.enum(["near_threshold", "random_low"]),
});

/** "Did we miss this?": stores the rating for evaluation and personalization. */
export async function rateMissedPostAction(input: z.input<typeof schema>): Promise<{ ok: boolean }> {
  const { profile } = await requireProfile();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false };
  const ok = await rateMissedCandidate(
    profile.id,
    parsed.data.candidateId,
    parsed.data.rating,
    parsed.data.sample,
  );
  // No refresh(): the card shows "Thanks" in place; tomorrow brings new posts
  return { ok };
}
