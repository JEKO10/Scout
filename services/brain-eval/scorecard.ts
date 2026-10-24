import type { EvalResult } from "@/db/schema";

type Criterion = {
  label: string;
  value: string;
  target: string;
  /** null until every result in the run has been rated */
  passed: boolean | null;
};

export type EvalScorecard = {
  total: number;
  rated: number;
  engageCount: number;
  criteria: Criterion[];
  passed: boolean | null;
};

/** Day 6 MVP pass criteria, scaled to the number of cases in the run. */
export function computeScorecard(
  results: Pick<
    EvalResult,
    "voiceScore" | "wouldPost" | "tooGeneric" | "decisionCorrect" | "decision"
  >[],
): EvalScorecard {
  const total = results.length;
  const rated = results.filter((result) => result.voiceScore !== null);
  const complete = total > 0 && rated.length === total;
  const count = (predicate: (result: (typeof results)[number]) => boolean) =>
    rated.filter(predicate).length;

  const avgVoice = rated.length
    ? rated.reduce((sum, result) => sum + (result.voiceScore ?? 0), 0) / rated.length
    : 0;
  const wouldPost = count((result) => result.wouldPost === true);
  const generic = count((result) => result.tooGeneric === true);
  const decisions = count((result) => result.decisionCorrect === true);

  const criterion = (
    label: string,
    value: string,
    target: string,
    pass: boolean,
  ): Criterion => ({ label, value, target, passed: complete ? pass : null });

  const criteria = [
    criterion("Sounds like me", avgVoice.toFixed(1), "≥ 4.0", avgVoice >= 4),
    criterion("Would post", `${wouldPost}/${total}`, `≥ ${Math.ceil(total * 0.7)}`, wouldPost >= total * 0.7),
    criterion("Too generic", `${generic}/${total}`, `≤ ${Math.floor(total * 0.2)}`, generic <= total * 0.2),
    criterion("Right engagement call", `${decisions}/${total}`, `≥ ${Math.ceil(total * 0.8)}`, decisions >= total * 0.8),
  ];

  return {
    total,
    rated: rated.length,
    engageCount: results.filter((result) => result.decision.shouldEngage).length,
    criteria,
    passed: complete ? criteria.every((item) => item.passed) : null,
  };
}
