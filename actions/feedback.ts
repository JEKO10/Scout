"use server";

import type { z } from "zod";

import { requireProfile } from "@/lib/auth/session";
import { type feedbackSchema, submitFeedback } from "@/services/feedback/submit";

/** The "Feedback" button: stored for the signed-in user, rate limited */
export async function submitFeedbackAction(
  input: z.input<typeof feedbackSchema>,
): Promise<{ ok: boolean; message: string }> {
  const { profile } = await requireProfile();
  return submitFeedback(profile.id, input);
}
