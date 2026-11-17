import type { DailyCount } from "@/lib/trends/types";

const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Posts per day, drawn only from days Scout was collecting (never invented
 * zeros before that), and only with at least three such days.
 */
export function TrendBars({ counts }: { counts: DailyCount[] }) {
  if (counts.length < 3) return null;
  const max = Math.max(1, ...counts.map((count) => count.posts));
  return (
    <figure className="trend-bars" aria-label={`Posts per day: ${counts.map((c) => `${c.day} ${c.posts}`).join(", ")}`}>
      <div>
        {counts.map((count) => (
          <span key={count.day} title={`${day.format(new Date(`${count.day}T12:00:00Z`))}: ${count.posts} posts`}>
            <i style={{ height: `${Math.max(4, (count.posts / max) * 100)}%` }} />
          </span>
        ))}
      </div>
      <figcaption>
        Posts per day in your scans, {day.format(new Date(`${counts[0].day}T12:00:00Z`))}–
        {day.format(new Date(`${counts.at(-1)!.day}T12:00:00Z`))}
      </figcaption>
    </figure>
  );
}
