import "server-only";

import { z } from "zod";

import { countFeedbackSince, insertFeedback } from "@/db/queries/feedback";
import { track } from "@/services/analytics/track";

/** Generous for real use, tight enough to stop a script */
export const FEEDBACK_LIMITS = [
  { windowMs: 10 * 60_000, max: 3 },
  { windowMs: 24 * 60 * 60_000, max: 10 },
];

export const feedbackSchema = z.object({
  category: z.enum(["bug", "feature", "general"]),
  message: z.string().trim().max(2000, "Keep it under 2,000 characters.").optional(),
  // Only the path of the page it came from: no query strings or other ids
  path: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9/_-]*$/)
    .optional(),
});

/** Stores feedback for this profile, unless it has sent too much recently */
export async function submitFeedback(
  profileId: string,
  input: z.input<typeof feedbackSchema>,
): Promise<{ ok: boolean; message: string }> {
  const parsed = feedbackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check your feedback." };

  for (const limit of FEEDBACK_LIMITS) {
    const recent = await countFeedbackSince(profileId, new Date(Date.now() - limit.windowMs));
    if (recent >= limit.max) {
      return { ok: false, message: "Thanks, we've got a lot from you already. Try again a bit later." };
    }
  }

  await insertFeedback({
    profileId,
    category: parsed.data.category,
    message: parsed.data.message || null,
    path: parsed.data.path ?? null,
  });
  // The category only: never the message
  await track("feedback_submitted", { profileId, props: { category: parsed.data.category } });
  return { ok: true, message: "Thanks! Your feedback was sent. We read every message during the beta." };
}
