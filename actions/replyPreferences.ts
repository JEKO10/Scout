"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { saveReplyPreferences } from "@/db/queries/profiles";
import { requireProfile } from "@/lib/auth/session";
import { normalizeReplyPreferences, REPLY_PREFERENCE_LIMITS } from "@/lib/scout/replyPreferences";

const list = z.array(z.string().max(500)).max(50);
const schema = z.object({ want: list, avoid: list });

/** Settings: what the user wants to reply to, and what not. Brain data is untouched. */
export async function saveReplyPreferencesAction(
  input: z.input<typeof schema>,
): Promise<{ ok: boolean; message: string }> {
  const { profile } = await requireProfile();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check your preferences." };

  const preferences = normalizeReplyPreferences(parsed.data);
  const overLimit =
    parsed.data.want.filter((item) => item.trim()).length > REPLY_PREFERENCE_LIMITS.items ||
    parsed.data.avoid.filter((item) => item.trim()).length > REPLY_PREFERENCE_LIMITS.items;
  await saveReplyPreferences(profile.id, preferences);
  refresh();
  return {
    ok: true,
    message: overLimit
      ? `Saved the first ${REPLY_PREFERENCE_LIMITS.items} of each list.`
      : "Reply preferences saved.",
  };
}
