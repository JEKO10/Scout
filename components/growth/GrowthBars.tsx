const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * A plain bar chart of real observations only: days without data are left
 * out rather than drawn as zero.
 */
export function GrowthBars({ points, caption, unit }: { points: { day: string; value: number }[]; caption: string; unit: string }) {
  const max = Math.max(1, ...points.map((point) => point.value));
  const min = Math.min(...points.map((point) => point.value));
  // Follower counts move little: start bars near the lowest value so changes show
  const floor = unit === "followers" ? Math.max(0, min - (max - min || 1)) : 0;
  return (
    <figure className="trend-bars growth-bars" aria-label={`${caption}: ${points.map((p) => `${p.day} ${p.value}`).join(", ")}`}>
      <div>
        {points.map((point) => (
          <span key={point.day} title={`${dayLabel.format(new Date(`${point.day}T12:00:00Z`))}: ${point.value.toLocaleString("en-US")} ${unit}`}>
            <i style={{ height: `${Math.max(4, ((point.value - floor) / (max - floor || 1)) * 100)}%` }} />
          </span>
        ))}
      </div>
      <figcaption>
        {caption}, {dayLabel.format(new Date(`${points[0].day}T12:00:00Z`))}–{dayLabel.format(new Date(`${points.at(-1)!.day}T12:00:00Z`))}
      </figcaption>
    </figure>
  );
}
