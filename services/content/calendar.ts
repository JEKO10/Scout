import "server-only";

import { z } from "zod";

import { getDraft, getNewlyMissed, markMissedNoted, updateDraft } from "@/db/queries/content";
import type { Profile } from "@/db/schema";
import { isValidTimeZone, normalizeXPostUrl, zonedTimeToUtc } from "@/lib/content/calendar";
import { CONTENT_GOALS } from "@/lib/content/types";
import { track } from "@/services/analytics/track";

// Day 32 Content Calendar: planning a draft for a date. Nothing is posted.

export type CalendarResult = { ok: true; message?: string } | { ok: false; message: string };

const planSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date."),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time."),
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone."),
  goal: z.enum(CONTENT_GOALS).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Plan (or re-plan) a draft: stored in UTC with the time zone it was planned in */
export async function planDraft(profile: Profile, draftId: string, raw: z.input<typeof planSchema>): Promise<CalendarResult> {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the date." };
  const draft = await getDraft(profile.id, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  const plannedAt = zonedTimeToUtc(parsed.data.date, parsed.data.time, parsed.data.timeZone);
  if (!plannedAt) return { ok: false, message: "That date doesn't exist." };

  await updateDraft(profile.id, draftId, {
    plannedAt,
    timeZone: parsed.data.timeZone,
    planNote: parsed.data.note || null,
    ...(parsed.data.goal ? { goal: parsed.data.goal } : {}),
    // A new date gives the plan a fresh chance: it's no longer "missed"
    missedNotedAt: null,
    archivedAt: null,
  });
  await track(draft.plannedAt ? "content_rescheduled" : "content_planned", { profileId: profile.id });
  return { ok: true, message: draft.plannedAt ? "Moved. Scout won't post it: you post it on X." : "Planned. Scout won't post it: you post it on X." };
}

/** Takes the draft off the calendar; the draft itself stays */
export async function unplanDraft(profile: Profile, draftId: string): Promise<CalendarResult> {
  const updated = await updateDraft(profile.id, draftId, { plannedAt: null, timeZone: null, missedNotedAt: null });
  return updated ? { ok: true, message: "Removed from the calendar. The draft is kept." } : { ok: false, message: "Draft not found." };
}

export async function setArchived(profile: Profile, draftId: string, archived: boolean): Promise<CalendarResult> {
  const updated = await updateDraft(profile.id, draftId, { archivedAt: archived ? new Date() : null });
  return updated ? { ok: true } : { ok: false, message: "Draft not found." };
}

/** After posting: the post's link on X (validated; user-entered, not verified by X) */
export async function savePublishedUrl(profile: Profile, draftId: string, raw: string): Promise<CalendarResult> {
  const url = raw.trim() ? normalizeXPostUrl(raw) : null;
  if (raw.trim() && !url) return { ok: false, message: "That isn't an X post link (https://x.com/handle/status/…)." };
  const draft = await getDraft(profile.id, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  await updateDraft(profile.id, draftId, {
    publishedUrl: url,
    // A link means the user says it's posted
    ...(url && !draft.publishedConfirmedAt ? { publishedConfirmedAt: new Date() } : {}),
  });
  if (url) await track("content_published_url_saved", { profileId: profile.id });
  return { ok: true, message: url ? "Link saved." : "Link removed." };
}

/** Records each newly missed plan once (analytics); the drafts themselves don't change */
export async function noteMissedPlans(profileId: string, now = new Date()): Promise<number> {
  const missed = await getNewlyMissed(profileId, now);
  await Promise.all(missed.map(() => track("content_plan_missed", { profileId })));
  await markMissedNoted(
    profileId,
    missed.map((draft) => draft.id),
  );
  return missed.length;
}
