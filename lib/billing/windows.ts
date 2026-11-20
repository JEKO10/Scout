// Counting windows for per-plan item limits (UTC): a day, a week from
// Monday, or a calendar month. Pure.

export type LimitWindow = "day" | "week" | "month";

/** The first day of the window that contains `now`, as YYYY-MM-DD */
export function windowStart(window: LimitWindow, now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const start =
    window === "day" ? new Date(Date.UTC(y, m, d)) : window === "week" ? new Date(Date.UTC(y, m, d - ((now.getUTCDay() + 6) % 7))) : new Date(Date.UTC(y, m, 1));
  return start.toISOString().slice(0, 10);
}
