// Day 27 Lead Scout: what the user sells and to whom, and how a lead is scored.

/** The ideal customer profile. Short lists; every field is the user's to edit. */
export type LeadProfile = {
  product: string;
  audience: string;
  problems: string[];
  industries: string[];
  buyingSignals: string[];
  excluded: string[];
};

export const LEAD_INTENTS = ["high", "medium", "low"] as const;
export type LeadIntent = (typeof LEAD_INTENTS)[number];

/**
 * Transparent 0–100 lead score. The AI judges the first four from the post
 * itself; recency is computed. A ranking aid, not a probability of buying.
 */
export type LeadScoreBreakdown = {
  /** How well the author fits the ideal customer, 0–30 */
  icpFit: number;
  /** How clearly they signal a need or search, 0–35 */
  intentStrength: number;
  /** How closely the problem matches what the product solves, 0–20 */
  problemFit: number;
  /** How explicit the post is (not inferred), 0–10 */
  evidence: number;
  /** Newer posts first, 0–5 */
  recency: number;
};

export const LEAD_SCORE_MAX: LeadScoreBreakdown = {
  icpFit: 30,
  intentStrength: 35,
  problemFit: 20,
  evidence: 10,
  recency: 5,
};

export function leadScore(breakdown: LeadScoreBreakdown): number {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value)));
  return (Object.keys(LEAD_SCORE_MAX) as (keyof LeadScoreBreakdown)[]).reduce(
    (sum, key) => sum + clamp(breakdown[key], LEAD_SCORE_MAX[key]),
    0,
  );
}

/** 5 for the last 6 hours, down to 0 at 7 days */
export function recencyPoints(postedAt: Date, now = new Date()): number {
  const hours = (now.getTime() - postedAt.getTime()) / 3_600_000;
  if (hours <= 6) return 5;
  if (hours >= 168) return 0;
  return Math.round(5 * (1 - (hours - 6) / 162));
}
