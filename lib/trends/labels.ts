import type { TrendConfidence, TrendMomentum, TrendOpportunityBreakdown, TrendStatus, TrendTiming } from "./types";

export const STATUS_LABEL: Record<TrendStatus, string> = {
  emerging: "Emerging",
  rising: "Rising",
  stable: "Stable",
  declining: "Declining",
  newly_detected: "Newly detected",
  insufficient_history: "Insufficient history",
};

export const CONFIDENCE_LABEL: Record<TrendConfidence, string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

/** "26 posts in the last 24 h vs 8 the 24 h before (+225%)", or why there's no comparison */
export function momentumText(momentum: TrendMomentum): string {
  const window = `${momentum.windowHours} h`;
  if (!momentum.comparable) {
    return `${momentum.current} posts in the last ${window}. Not enough scan history yet to compare with the ${window} before.`;
  }
  const growth = momentum.growthPct === null ? "" : ` (${momentum.growthPct > 0 ? "+" : ""}${momentum.growthPct}%)`;
  return `${momentum.current} posts in the last ${window} vs ${momentum.previous} in the ${window} before${growth}.`;
}

export const TIMING_LABEL: Record<TrendTiming, string> = {
  act_now: "Act now",
  worth_exploring: "Worth exploring",
  monitor: "Monitor",
  low_priority: "Low priority",
};

/** One plain sentence per timing, saying what it's based on */
export const TIMING_TEXT: Record<TrendTiming, string> = {
  act_now: "Relevant to you, active in the last 12 hours, with conversations you can join now.",
  worth_exploring: "Relevant enough to read up on and join where you have something to add.",
  monitor: "Keep an eye on it: either the data is still thin or it's only partly relevant.",
  low_priority: "Little relevance or momentum for you right now.",
};

export function opportunityExplanation(b: TrendOpportunityBreakdown): string {
  return `relevance to you ${b.relevance}/35 · momentum ${b.momentum}/20 · audience fit ${b.audience}/15 · real conversations ${b.conversation}/10 · open opportunities ${b.openings}/10 · data confidence ${b.confidence}/10`;
}
