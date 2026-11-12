import {
  SCORING_STRATEGIES,
  type ScoringStrategy,
} from "@/services/opportunities/scoringStrategy";

// Strategy variants that exist only for evaluation. They are never reachable
// through SCOUT_SCORING_STRATEGY, so production can't pick one by accident.

export const EVAL_VARIANTS = {
  /** optimized (prompt v2, short output, batches of 15) with gpt-5.5's default reasoning */
  "optimized-medium": {
    ...SCORING_STRATEGIES.optimized,
    primary: { ...SCORING_STRATEGIES.optimized.primary, reasoningEffort: "medium" },
  },
} satisfies Record<string, Omit<ScoringStrategy, "id"> & { id: ScoringStrategy["id"] }>;

export type EvalVariantId = keyof typeof EVAL_VARIANTS;

export function isEvalVariant(id: string): id is EvalVariantId {
  return id in EVAL_VARIANTS;
}
