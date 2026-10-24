import type { EvalScorecard } from "@/services/brain-eval/scorecard";

export function EvalScorecardView({
  scorecard,
  caption,
}: {
  scorecard: EvalScorecard;
  caption: string;
}) {
  const verdict =
    scorecard.passed === null
      ? `${scorecard.rated}/${scorecard.total} rated`
      : scorecard.passed
        ? "Brain is good enough → Day 7"
        : "Not yet → fix the Brain (Day 5)";

  return (
    <section className="eval-scorecard" aria-label="Eval results">
      <div className="eval-scorecard-head">
        <p className="eyebrow">{caption}</p>
        <strong data-passed={scorecard.passed ?? undefined}>{verdict}</strong>
      </div>

      <div className="metrics-strip">
        {scorecard.criteria.map((criterion) => (
          <div className="metric" key={criterion.label} data-passed={criterion.passed ?? undefined}>
            <strong>{criterion.value}</strong>
            <span>
              {criterion.label} · target {criterion.target}
            </span>
          </div>
        ))}
      </div>

      {scorecard.engageCount === scorecard.total && scorecard.total > 0 && (
        <p className="eval-note">
          Scout wants to engage with all {scorecard.total} posts. A good Brain says no
          to some of them, so the decision prompt or Interest Brain is too permissive.
        </p>
      )}
    </section>
  );
}
