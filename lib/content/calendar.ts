// Day 32 Content Calendar: time zones, the content lifecycle and the planning
// assistant. Planning only: nothing here posts anything. Pure, no I/O.
import { type ContentGoal, GOAL_LABEL } from "./types";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of an instant in a time zone */
export function zonedParts(date: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    offsetMs:
      Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) -
      Math.floor(date.getTime() / 1000) * 1000,
  };
}

/**
 * "2026-11-20" at "09:30" in Europe/Belgrade → the UTC instant. Handles DST:
 * the offset is taken at the target time itself (two passes).
 */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match || !clock || !isValidTimeZone(tz)) return null;
  const asUtc = Date.UTC(+match[1], +match[2] - 1, +match[3], +clock[1], +clock[2]);
  let guess = new Date(asUtc - zonedParts(new Date(asUtc), tz).offsetMs);
  guess = new Date(asUtc - zonedParts(guess, tz).offsetMs);
  // Reject impossible dates (e.g. 2026-02-31 rolled into March)
  return zonedParts(guess, tz).date === date ? guess : null;
}

export const LIFECYCLE = ["draft", "ready", "planned", "missed", "published", "archived"] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  draft: "Draft",
  ready: "Ready to publish",
  planned: "Planned",
  missed: "Missed",
  published: "Published",
  archived: "Archived",
};

/**
 * The status shown for a draft. "Missed" is derived (planned time passed,
 * not confirmed) and never stored; nothing becomes "Published" without the
 * user confirming it.
 */
export function lifecycle(
  draft: { status: "draft" | "ready"; plannedAt: Date | null; publishedConfirmedAt: Date | null; archivedAt: Date | null },
  now = new Date(),
): Lifecycle {
  if (draft.archivedAt) return "archived";
  if (draft.publishedConfirmedAt) return "published";
  if (draft.plannedAt) return draft.plannedAt < now ? "missed" : "planned";
  return draft.status;
}

/** x.com or twitter.com status links only: https://x.com/<handle>/status/<id> */
export function normalizeXPostUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname)) return null;
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\/?$/.exec(url.pathname);
  return match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
}

/** Monday-first weeks: the dates (YYYY-MM-DD) shown for a month or a week */
export function calendarDays(anchor: string, view: "month" | "week"): string[] {
  const [y, m, d] = anchor.split("-").map(Number);
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const start = view === "month" ? new Date(Date.UTC(y, m - 1, 1)) : new Date(Date.UTC(y, m - 1, d));
  const back = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - back);
  const count = view === "week" ? 7 : (() => {
    const last = new Date(Date.UTC(y, m, 0));
    const total = back + last.getUTCDate();
    return Math.ceil(total / 7) * 7;
  })();
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + i);
    return day(date);
  });
}

export function shiftAnchor(anchor: string, view: "month" | "week", by: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  const date = view === "month" ? new Date(Date.UTC(y, m - 1 + by, 1)) : new Date(Date.UTC(y, m - 1, d + by * 7));
  return date.toISOString().slice(0, 10);
}

// ---- Planning assistant ------------------------------------------------------

export type PlanItem = { goal: ContentGoal; lifecycle: Lifecycle; sourceTrendId: string | null };

export type WeekSummary = {
  planned: number;
  published: number;
  missed: number;
  awaitingReview: number;
  goals: Partial<Record<ContentGoal, number>>;
};

export function weekSummary(weekItems: PlanItem[], unplannedDrafts: PlanItem[]): WeekSummary {
  const goals: Partial<Record<ContentGoal, number>> = {};
  for (const item of weekItems) if (item.lifecycle !== "archived") goals[item.goal] = (goals[item.goal] ?? 0) + 1;
  return {
    planned: weekItems.filter((item) => item.lifecycle === "planned").length,
    published: weekItems.filter((item) => item.lifecycle === "published").length,
    missed: weekItems.filter((item) => item.lifecycle === "missed").length,
    awaitingReview: unplannedDrafts.filter((item) => item.lifecycle === "draft").length,
    goals,
  };
}

/**
 * Suggestions from the plan itself and saved trends. Deterministic, no AI,
 * and never a "best time to post" (that needs performance data Scout
 * doesn't have yet).
 */
export function planningAdvice(
  summary: WeekSummary,
  readyUnplanned: number,
  savedTrendsWithoutContent: string[],
): string[] {
  const advice: string[] = [];
  const total = Object.values(summary.goals).reduce((sum, n) => sum + (n ?? 0), 0);
  if (summary.missed > 0) {
    advice.push(`${summary.missed} planned ${summary.missed === 1 ? "post was" : "posts were"} missed this week. Post, reschedule or archive ${summary.missed === 1 ? "it" : "them"}.`);
  }
  if (total === 0) {
    advice.push(
      readyUnplanned > 0
        ? `Nothing planned this week, but ${readyUnplanned} ${readyUnplanned === 1 ? "draft is" : "drafts are"} ready. Give ${readyUnplanned === 1 ? "it" : "them"} a date.`
        : "Nothing planned this week. Start with one post in Content Studio.",
    );
  } else {
    const promo = (summary.goals.promote_product ?? 0) + (summary.goals.generate_leads ?? 0);
    if (total >= 3 && promo / total > 0.5) {
      advice.push(`${promo} of ${total} posts this week are promotional or lead-focused. Balance them with something educational or a question to your audience.`);
    }
    if (total >= 3 && !summary.goals.start_conversations) {
      advice.push(`You have ${total} posts this week but none meant to start a conversation. Consider a question about a challenge your audience has.`);
    }
    const educational = (summary.goals.educate ?? 0) + (summary.goals.build_authority ?? 0);
    if (total >= 3 && educational === 0) advice.push(`Nothing educational or authority-building is planned this week.`);
    if (readyUnplanned > 0) advice.push(`${readyUnplanned} ready ${readyUnplanned === 1 ? "draft has" : "drafts have"} no date yet.`);
  }
  for (const trend of savedTrendsWithoutContent.slice(0, 2)) advice.push(`You saved the trend "${trend}" but haven't written about it yet.`);
  return advice;
}

export function goalMixLabel(goal: ContentGoal): string {
  return GOAL_LABEL[goal];
}
