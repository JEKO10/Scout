const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "just now", "18 minutes ago", "3 hours ago", "yesterday"… */
export function formatRelative(date: Date) {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");

  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");

  return relativeTime.format(Math.round(hours / 24), "day");
}
