// Day 36: how a review item's due time reads. Plan tasks are due on a day
// (stored as that day's midnight UTC), so they read "today" / "yesterday",
// never "due 21 hours ago"; everything else has a real time.

const DAY_MS = 86_400_000;

/** "today", "yesterday", "tomorrow", or "on Nov 16", for a YYYY-MM-DD day vs the user's local today */
export function dayLabel(day: string, today: string): string {
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (diff === 0) return "today";
  if (diff === -1) return "yesterday";
  if (diff === 1) return "tomorrow";
  return `on ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`))}`;
}

/** The due text of a queue item; `relative` formats real times ("in 2 hours") */
export function dueLabel(
  item: { entityType: string; dueAt: Date | null; createdAt: Date },
  today: string,
  relative: (date: Date) => string,
): string {
  if (!item.dueAt) return relative(item.createdAt);
  if (item.entityType === "strategy_task") return `due ${dayLabel(item.dueAt.toISOString().slice(0, 10), today)}`;
  return `due ${relative(item.dueAt)}`;
}
