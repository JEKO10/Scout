// Day 29 Trend Scout: shapes shared by detection, storage and the pages.

export const TREND_STATUSES = ["emerging", "rising", "stable", "declining", "newly_detected", "insufficient_history"] as const;
export type TrendStatus = (typeof TREND_STATUSES)[number];

export const TREND_CONFIDENCE = ["low", "medium", "high"] as const;
export type TrendConfidence = (typeof TREND_CONFIDENCE)[number];

/** Posts seen in two equal windows; growth only when the windows are comparable */
export type TrendMomentum = {
  windowHours: number;
  current: number;
  previous: number;
  /** null when Scout's coverage of the previous window can't support a comparison */
  growthPct: number | null;
  comparable: boolean;
};

/** Transparent parts of the 0–100 trend score */
export type TrendScoreBreakdown = {
  /** 0–35: observed momentum (0 without comparable history) */
  momentum: number;
  /** 0–35: how relevant the posts were to the user's Scout Brain */
  relevance: number;
  /** 0–10: likes, replies and reposts X reported */
  engagement: number;
  /** 0–10: distinct authors */
  sources: number;
  /** 0–10: how recent the latest post is */
  freshness: number;
};

/** Posts per UTC day over the observation period; only days Scout was collecting */
export type DailyCount = { day: string; posts: number };

// ---- Day 30 Trend Intelligence ----------------------------------------------

/** How worthwhile it is for this user to take part; each part explained on the page */
export type TrendOpportunityBreakdown = {
  /** 0–35: Scout Brain relevance of its posts */
  relevance: number;
  /** 0–20: observed momentum (0 without comparable history) */
  momentum: number;
  /** 0–15: share of its posts the scoring said are worth engaging with */
  audience: number;
  /** 0–10: posts that are real conversations (replies on X) */
  conversation: number;
  /** 0–10: open opportunities you could reply to now */
  openings: number;
  /** 0–10: confidence in the data */
  confidence: number;
};

export const TREND_TIMINGS = ["act_now", "worth_exploring", "monitor", "low_priority"] as const;
export type TrendTiming = (typeof TREND_TIMINGS)[number];

/** AI interpretation of a trend, written from its representative posts only */
export type TrendInsight = {
  summary: string;
  discussion: string;
  /** What seems to drive it, or "Not clear from these posts" */
  drivers: string;
  recurringQuestions: string[];
  sentiment: "positive" | "negative" | "mixed" | "neutral";
  whyItMatters: string;
  angles: { educational: string; personal: string; practical: string; contrarian: string | null };
  hooks: string[];
  format: { type: "short_post" | "thread" | "reply" | "question"; why: string };
  recommendedAction: string;
  /** scout_candidates IDs the insight is grounded in (a subset of the trend's posts) */
  supportingCandidateIds: string[];
};
