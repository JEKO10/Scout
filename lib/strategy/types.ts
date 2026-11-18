// Day 34 Growth Strategist: the shapes shared by evidence, AI output,
// validation, storage and the page. No server-only code here.

import type { Confidence, GrowthMetric } from "@/lib/growth/analyze";

/** What the user is growing for: recommendations follow it, never "more followers" by default */
export const STRATEGY_OBJECTIVES = [
  "find_customers",
  "generate_leads",
  "build_authority",
  "grow_audience",
  "meaningful_engagement",
] as const;
export type StrategyObjective = (typeof STRATEGY_OBJECTIVES)[number];

export const OBJECTIVE_LABEL: Record<StrategyObjective, string> = {
  find_customers: "Find customers",
  generate_leads: "Generate leads",
  build_authority: "Build authority",
  grow_audience: "Grow an audience",
  meaningful_engagement: "More meaningful conversations",
};

/** Time the user can put in per week; the plan never asks for more */
export const WEEKLY_MINUTES_OPTIONS = [60, 120, 180, 300] as const;

/** Scout modules a task can send the user to. Links are built here, never by the AI. */
export const STRATEGY_MODULES = ["studio", "calendar", "trends", "opportunities", "leads", "growth", "discovery"] as const;
export type StrategyModule = (typeof STRATEGY_MODULES)[number];

export const MODULE_LINK: Record<StrategyModule, { href: string; label: string }> = {
  studio: { href: "/studio", label: "Content Studio" },
  calendar: { href: "/calendar", label: "Content Calendar" },
  trends: { href: "/trends", label: "Trend Scout" },
  opportunities: { href: "/opportunities", label: "Opportunities" },
  leads: { href: "/crm", label: "Lead CRM" },
  growth: { href: "/growth", label: "Growth Intelligence" },
  discovery: { href: "/discovery", label: "Smart Discovery" },
};

/**
 * One verified observation the strategy may cite. Numbers are computed by
 * Scout from stored data; the AI only references the ID.
 */
export type EvidenceItem = {
  id: string;
  /**
   * works / weak: one group vs the rest of the posts. comparison: two or more
   * groups of the same dimension on the same metric (e.g. standard vs short
   * posts), merged so one comparison never counts as two pieces of evidence.
   */
  kind: "works" | "weak" | "comparison" | "activity" | "trend" | "lead" | "content" | "metric" | "peer" | "profile";
  /**
   * Day 35: where it comes from. Confidence means different things per type:
   * own analytics can support decisions; peer observations only suggest
   * ideas to test (never proof for this user); profile context isn't a measurement.
   * Absent on plans made before Day 35 (derived from `kind`).
   */
  evidenceType?: EvidenceType;
  /** Plain statement with the numbers, shown to the user next to recommendations */
  text: string;
  source: "growth" | "opportunities" | "trends" | "leads" | "studio" | "calendar";
  /** Posts (or items) behind it; null when it's a count, not a comparison */
  sampleSize: number | null;
  confidence: Confidence | null;
  /** Strong enough to justify doing less of something (a weak pattern over enough posts) */
  supportsReduction: boolean;
  /** Peer observations: the accounts behind it (shown as "influenced by") */
  peerHandles?: string[];
  /** Patterns: the metric that was compared; recommendations must speak about this metric */
  metric?: "impressions" | "engagement_rate" | "replies";
};

export const EVIDENCE_TYPES = ["own_analytics", "peer_observation", "scout_activity", "profile_context"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** What a recommendation rests on, shown to the user; "hypothesis": nothing measured yet */
export type SourceType = EvidenceType | "hypothesis";

export const SOURCE_LABEL: Record<SourceType, string> = {
  own_analytics: "Your analytics",
  peer_observation: "Peer observation",
  scout_activity: "Scout activity",
  profile_context: "Your profile",
  hypothesis: "Initial hypothesis",
};

/** The evidence type of an item, also for items saved before Day 35 */
export function evidenceTypeOf(item: Pick<EvidenceItem, "kind" | "evidenceType">): EvidenceType {
  if (item.evidenceType) return item.evidenceType;
  if (item.kind === "peer") return "peer_observation";
  if (item.kind === "profile") return "profile_context";
  if (item.kind === "activity" || item.kind === "trend" || item.kind === "lead" || item.kind === "content") return "scout_activity";
  return "own_analytics";
}

/** Day 35 strategy stages, from the user's own evidence (not post counts alone) */
export const STRATEGY_STAGES = ["starting", "learning", "evidence"] as const;
export type StrategyStage = (typeof STRATEGY_STAGES)[number];

export const STAGE_INFO: Record<StrategyStage, { label: string; focus: string }> = {
  starting: {
    label: "Starting out",
    focus: "Not enough of your own data yet. The plan builds a baseline: first posts, relevant conversations and small experiments.",
  },
  learning: {
    label: "Learning",
    focus: "Some of your own data, but not enough to be sure. The plan compares early patterns with your hypotheses and keeps testing.",
  },
  evidence: {
    label: "Evidence-based growth",
    focus: "Enough of your own data over a meaningful period. The plan builds on what works for you and uses peers only for new ideas.",
  },
};

/** One week of the four-week roadmap */
export type RoadmapWeek = {
  week: number;
  objective: string;
  activities: string[];
  milestone: string;
  modules: StrategyModule[];
  measure: string[];
  /** "template": Scout's deterministic fallback when the AI's roadmap didn't pass validation */
  source?: "ai" | "template";
};

/** Patterns, from Growth findings (as opposed to counts of activity) */
export const PATTERN_KINDS: EvidenceItem["kind"][] = ["works", "weak", "comparison"];

export const METRIC_NAME: Record<NonNullable<EvidenceItem["metric"]>, string> = {
  impressions: "impressions per post",
  engagement_rate: "engagement rate",
  replies: "replies per post",
};

/** Posts must cover at least this many days before a pattern counts as more than limited */
export const MIN_SPAN_DAYS = 21;
/** Experiments run at least this long (5+ posts per variant need time) */
export const MIN_EXPERIMENT_DAYS = 14;

/** Numbers compared between strategies (computed, never from the AI) */
export type StrategySnapshot = {
  postsLast30: number;
  postsPrevious30: number | null;
  medianImpressions: number | null;
  engagementRate: number | null;
  followers: number | null;
  repliesOpened: number;
};

export type StrategyEvidence = {
  /** Day 35; absent on evidence saved before */
  stage?: StrategyStage;
  items: EvidenceItem[];
  /** What Scout doesn't know, said plainly to the AI and the user */
  missing: string[];
  /** "evidence": enough history for patterns; "starter": a labeled experimentation plan */
  mode: "evidence" | "starter";
  snapshot: StrategySnapshot;
  /** Changes since the previous strategy, computed from the two snapshots */
  changes: string[];
};

export type Recommendation = {
  text: string;
  evidenceIds: string[];
  /** The metrics of the cited patterns, computed by Scout (absent on plans made before) */
  measuredBy?: string[];
  /** Day 35: what it rests on, computed from the cited evidence */
  sources?: SourceType[];
  /** Peer accounts whose observations it cites */
  influencedBy?: string[];
};
export type Priority = {
  title: string;
  why: string;
  evidenceIds: string[];
  /** "hypothesis": rests only on limited-confidence patterns, to test rather than act on */
  basis?: "evidence" | "hypothesis";
  measuredBy?: string[];
  sources?: SourceType[];
  influencedBy?: string[];
};
export type ExperimentReview = { experimentId: string; recommendation: "continue" | "modify" | "stop"; reason: string };

/** The validated AI part of a strategy */
export type StrategyContent = {
  summary: string;
  priorities: Priority[];
  doMore: Recommendation[];
  /** Positive patterns with limited confidence: hypotheses worth testing (absent on older plans) */
  toTest?: Recommendation[];
  doLess: Recommendation[];
  experimentReviews: ExperimentReview[];
  /** Day 35: four weeks of direction (starting and learning stages) */
  roadmap?: RoadmapWeek[];
};

// ---- Experiments ---------------------------------------------------------------

/**
 * How posts are split into the two variants. "custom": Scout can't tell the
 * variants apart from post data, so results are the user's own observations.
 */
export const EXPERIMENT_DIMENSIONS = ["length", "hook", "time", "custom"] as const;
export type ExperimentDimension = (typeof EXPERIMENT_DIMENSIONS)[number];

/** Variant pairs Scout can measure from post data (lib/growth/analyze classifiers) */
export const MEASURABLE_VARIANTS: Record<Exclude<ExperimentDimension, "custom">, Record<string, string>> = {
  length: { short: "Short posts (up to 100 characters)", standard: "Standard posts (101–280 characters)", long: "Long posts (over 280 characters)" },
  hook: { question: "Opening with a question", statement: "Opening with a statement", number: "Opening with a number", how_why: "Opening with how / why / what" },
  time: { morning: "Posted in the morning (5–12h)", afternoon: "Posted in the afternoon (12–17h)", evening: "Posted in the evening (17–22h)", night: "Posted at night (22–5h)" },
};

export const EXPERIMENT_METRICS = ["impressions", "engagement_rate", "replies"] as const satisfies readonly GrowthMetric[];
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

/** Posts per variant before a comparison is shown at all (matches Growth's MIN_GROUP) */
export const EXPERIMENT_MIN_PER_VARIANT = 5;

export type ExperimentPreset = {
  key: string;
  title: string;
  hypothesis: string;
  dimension: ExperimentDimension;
  variantA: string;
  variantB: string;
  metric: ExperimentMetric;
  durationDays: number;
  actions: string[];
};

/** Ready-made experiments a user can start without any AI call */
export const EXPERIMENT_PRESETS: ExperimentPreset[] = [
  {
    key: "length",
    title: "Short posts vs long posts",
    hypothesis: "Longer, more detailed posts get a higher engagement rate from my audience than short ones.",
    dimension: "length",
    variantA: "short",
    variantB: "long",
    metric: "engagement_rate",
    durationDays: 21,
    actions: ["Publish at least 5 short posts (up to 100 characters)", "Publish at least 5 long posts (over 280 characters) on similar topics"],
  },
  {
    key: "hook",
    title: "Question hooks vs statement hooks",
    hypothesis: "Posts that open with a question get more replies than posts that open with a statement.",
    dimension: "hook",
    variantA: "question",
    variantB: "statement",
    metric: "replies",
    durationDays: 21,
    actions: ["Open at least 5 posts with a question", "Open at least 5 posts with a plain statement"],
  },
  {
    key: "time",
    title: "Morning vs evening posting",
    hypothesis: "My posts reach more people when published in the morning than in the evening (my time zone).",
    dimension: "time",
    variantA: "morning",
    variantB: "evening",
    metric: "impressions",
    durationDays: 28,
    actions: ["Publish at least 5 posts between 5:00 and 12:00", "Publish at least 5 comparable posts between 17:00 and 22:00"],
  },
  {
    key: "problem_vs_product",
    title: "Problem-focused vs product-focused posts",
    hypothesis: "Posts about my audience's problem start more conversations than posts about my product.",
    dimension: "custom",
    variantA: "Problem-focused",
    variantB: "Product-focused",
    metric: "replies",
    durationDays: 21,
    actions: ["Publish 3-5 posts about a problem your audience has", "Publish 3-5 posts about your product", "Note which ones started conversations"],
  },
];

export type ExperimentResult =
  | { status: "manual"; note: string }
  | { status: "not_started" }
  | { status: "collecting"; aN: number; bN: number; needed: number }
  | {
      status: "directional";
      aN: number;
      bN: number;
      aMedian: number;
      bMedian: number;
      /** (A - B) / B; null when B is 0 */
      difference: number | null;
      confidence: Confidence;
      note: string;
    };

// ---- Day 35 Peer Intelligence -----------------------------------------------------

/**
 * direct: similar niche and comparable size. aspirational: much larger,
 * worth studying, never a benchmark. unknown: size not known, so
 * comparability can't be judged. The groups are never mixed.
 */
export type PeerCategory = "direct" | "aspirational" | "unknown";

export const PEER_CATEGORY_LABEL: Record<PeerCategory, string> = {
  direct: "Direct peer",
  aspirational: "Aspirational",
  unknown: "Comparability unknown",
};

/** Posts a peer needs inside the observation window before patterns are looked for */
export const PEER_MIN_POSTS = 10;
/** Peer post stats are kept this long (derived numbers only, no text) */
export const PEER_STATS_RETENTION_DAYS = 90;

/**
 * Whose observations a strategy uses. recommended: Scout picks the most
 * comparable saved peers (direct first). selected: exactly the accounts the
 * user selected, never substituted, even when they lack data.
 */
export const PEER_MODES = ["recommended", "selected"] as const;
export type PeerMode = (typeof PEER_MODES)[number];

export const PEER_MODE_LABEL: Record<PeerMode, string> = {
  recommended: "Scout recommended",
  selected: "My selected accounts",
};

/** Peers analyzed per strategy */
export const MAX_PEERS_PER_STRATEGY = 5;
