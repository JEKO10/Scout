// Smart notification rules (Day 19). Pure functions, so the same rules hold
// in the scheduler, the settings form and the tests.

export const NOTIFICATION_DEFAULTS = {
  slackEnabled: false,
  minScore: 80,
  maxPerDay: 5,
  quietHoursStart: null as number | null,
  quietHoursEnd: null as number | null,
  timezone: "UTC",
};

export const NOTIFICATION_LIMITS = {
  minScore: { min: 50, max: 100 },
  maxPerDay: { min: 1, max: 20 },
  /** Older posts are history, not alerts: the conversation has moved on */
  maxPostAgeHours: 24,
};

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function parts(date: Date, timezone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: isValidTimezone(timezone) ? timezone : "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return values as Record<"year" | "month" | "day" | "hour", string>;
}

/** The user's calendar day, "YYYY-MM-DD"; the daily limit resets with it. */
export function localDay(date: Date, timezone: string): string {
  const { year, month, day } = parts(date, timezone);
  return `${year}-${month}-${day}`;
}

/**
 * Whether `date` falls in the user's quiet hours, [start, end) in local
 * hours. Start after end spans midnight (22 → 7). Equal or unset: none.
 */
export function isQuietHours(
  date: Date,
  settings: { quietHoursStart: number | null; quietHoursEnd: number | null; timezone: string },
): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = settings;
  if (start === null || end === null || start === end) return false;
  const hour = Number(parts(date, settings.timezone).hour);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
