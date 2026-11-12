"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { confirmReplyPosted, recordReplyIntent, returnToFeed } from "@/db/queries/replyIntents";
import { requireProfile } from "@/lib/auth/session";
import { checkReplyText, isXPostId, normalizeReplyText } from "@/lib/replies/xIntent";

const intentSchema = z.object({
  opportunityId: z.uuid(),
  replyId: z.uuid().nullable(),
  text: z.string().max(5000),
  source: z.enum(["x_web_intent", "clipboard"]),
});

/**
 * Called as the browser opens X's composer (the link navigates on its own,
 * so the click is never lost to a popup blocker). Records the attempt with
 * the final text; never claims the reply was posted.
 */
export async function recordReplyIntentAction(
  input: z.input<typeof intentSchema>,
): Promise<{ ok: boolean; message?: string }> {
  const { profile } = await requireProfile();
  const parsed = intentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid reply." };
  const check = checkReplyText(parsed.data.text);
  if (!check.ok) return { ok: false, message: check.error };

  const result = await recordReplyIntent(profile.id, {
    ...parsed.data,
    text: normalizeReplyText(parsed.data.text),
    isValidPostId: isXPostId,
  });
  if (!result.ok) {
    return {
      ok: false,
      message: result.reason === "not_an_x_post" ? "This post can't be replied to on X." : "Opportunity not found.",
    };
  }
  return { ok: true };
}

const opportunitySchema = z.uuid();

/** Activity: "Mark as posted" (self-reported). */
export async function confirmReplyPostedAction(opportunityId: string): Promise<{ ok: boolean }> {
  const { profile } = await requireProfile();
  const id = opportunitySchema.safeParse(opportunityId);
  if (!id.success) return { ok: false };
  const ok = await confirmReplyPosted(profile.id, id.data);
  if (ok) refresh();
  return { ok };
}

/** Activity: "Return to opportunities". */
export async function returnToFeedAction(opportunityId: string): Promise<{ ok: boolean }> {
  const { profile } = await requireProfile();
  const id = opportunitySchema.safeParse(opportunityId);
  if (!id.success) return { ok: false };
  const ok = await returnToFeed(profile.id, id.data);
  if (ok) refresh();
  return { ok };
}
