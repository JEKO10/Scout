import type { RankingCheck } from "@/services/opportunities/rankingCheck";
import { SURFACE_THRESHOLD } from "@/services/opportunities/score";

export function RankingCheckView({ check }: { check: RankingCheck }) {
  const ready = check.compared > 0 && check.unlabeled === 0;

  return (
    <details className="ranking-check">
      <summary>
        Show Scout&apos;s results
        <span>
          {ready
            ? `${check.compared} posts compared`
            : "Label every post first, so Scout's scores don't influence you"}
        </span>
      </summary>

      <div className="ranking-check-body">
        {check.unscored > 0 && (
          <p className="scout-run-note">
            {check.unscored} candidates aren&apos;t scored yet; Run Scout again to score them.
          </p>
        )}

        <dl className="ranking-check-metrics">
          <div>
            <dt>Your YES that Scout surfaced</dt>
            <dd>
              {check.yesSurfaced} / {check.yes}
            </dd>
          </div>
          <div>
            <dt>Your YES in Scout&apos;s top {check.yes}</dt>
            <dd>
              {check.yesInTopN} / {check.yes}
            </dd>
          </div>
          <div>
            <dt>Scout&apos;s picks you&apos;d want (YES or MAYBE)</dt>
            <dd>
              {check.surfacedWanted} / {check.surfaced}
            </dd>
          </div>
          <div>
            <dt>Average score: YES · MAYBE · NO</dt>
            <dd>
              {[check.averageScore.yes, check.averageScore.maybe, check.averageScore.no]
                .map((score) => score ?? "–")
                .join(" · ")}
            </dd>
          </div>
        </dl>

        <p className="scout-run-note">
          Scout surfaces a post when it scores {SURFACE_THRESHOLD}+ and it thinks you should
          engage.
        </p>

        <Disagreements
          title="You said YES, Scout passed"
          items={check.missed}
        />
        <Disagreements title="You said NO, Scout surfaced it" items={check.wrong} />
      </div>
    </details>
  );
}

function Disagreements({
  title,
  items,
}: {
  title: string;
  items: RankingCheck["missed"];
}) {
  if (items.length === 0) return null;
  return (
    <div className="ranking-check-list">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <p>
              <strong>{item.score}</strong> · @{item.authorHandle} ·{" "}
              {item.content.slice(0, 140)}
              {item.content.length > 140 ? "…" : ""}
            </p>
            {item.reason && <p className="scout-run-note">Scout: {item.reason}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
