import type { CandidateJudgment } from "@/lib/ai/schemas/opportunity";
import type { OpportunityScoreBreakdown } from "@/lib/scout/types";

// The deterministic half of opportunity scoring: "code where we can, AI where
// we must". Pure functions, no I/O.

const FRESH_FOR_HOURS = 2;
const STALE_AFTER_HOURS = 72;

/** 0–15: full points for the first 2 hours, then linear decay to 0 at 72 hours. */
export function freshnessPoints(postedAt: Date, now: Date): number {
  const hours = (now.getTime() - postedAt.getTime()) / 3_600_000;
  if (hours <= FRESH_FOR_HOURS) return 15;
  if (hours >= STALE_AFTER_HOURS) return 0;
  const remaining = 1 - (hours - FRESH_FOR_HOURS) / (STALE_AFTER_HOURS - FRESH_FOR_HOURS);
  return Math.round(15 * remaining);
}

// The model is told the ranges; clamping keeps a slip from breaking the total
const clamp = (value: number, max: number) =>
  Math.min(max, Math.max(0, Math.round(value)));

export function scoreBreakdown(
  judgment: CandidateJudgment,
  freshness: number,
): OpportunityScoreBreakdown {
  return {
    relevance: clamp(judgment.relevance, 25),
    goalAlignment: clamp(judgment.goalAlignment, 20),
    expertiseFit: clamp(judgment.expertiseFit, 20),
    freshness,
    audienceValue: clamp(judgment.audienceValue, 10),
    novelty: clamp(judgment.novelty, 10),
  };
}

export const totalScore = (breakdown: OpportunityScoreBreakdown) =>
  Object.values(breakdown).reduce((sum, points) => sum + points, 0);

/** Starting threshold; tune it later from real data. */
export const SURFACE_THRESHOLD = 75;

export const shouldSurface = (score: number, shouldEngage: boolean) =>
  shouldEngage && score >= SURFACE_THRESHOLD;

export type OpportunityTier = "exceptional" | "high" | "medium" | "low";

export function opportunityTier(score: number): OpportunityTier {
  if (score >= 90) return "exceptional";
  if (score >= 80) return "high";
  if (score >= 70) return "medium";
  return "low";
}
