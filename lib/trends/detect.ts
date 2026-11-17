// Day 29 Trend Scout: grouping the posts Scout already scored into trends and
// measuring their momentum. Deterministic and free: it uses the topic label
// the scoring step already gave each post (no new AI or X calls). Pure, no I/O.
import type {
  DailyCount,
  TrendConfidence,
  TrendMomentum,
  TrendOpportunityBreakdown,
  TrendScoreBreakdown,
  TrendStatus,
  TrendTiming,
} from "./types";

export type TrendPost = {
  id: string;
  label: string | null;
  content: string;
  authorKey: string;
  postedAt: Date;
  /** The opportunity score: relevance to the user's Scout Brain, 0–100 */
  score: number;
  metrics: { likes?: number; replies?: number; reposts?: number } | null;
  discoveryTopicId: string | null;
  reason: string | null;
  /** Day 30: the scoring said a reply from the user would add something */
  shouldEngage?: boolean | null;
  /** Day 30: it's an opportunity the user can still act on (new or saved) */
  openOpportunity?: boolean;
};

/** When Scout was collecting for this user, so windows are only compared when both were covered */
export type Coverage = {
  /** First completed scan */
  collectingSince: Date | null;
  scansInCurrentWindow: number;
  scansInPreviousWindow: number;
};

export type TrendDraft = {
  key: string;
  label: string;
  terms: string[];
  summary: string;
  why: string | null;
  discoveryTopicId: string | null;
  status: TrendStatus;
  confidence: TrendConfidence;
  score: number;
  relevance: number;
  scoreBreakdown: TrendScoreBreakdown;
  momentum: TrendMomentum;
  dailyCounts: DailyCount[];
  postCount: number;
  authorCount: number;
  engagement: number;
  representativeIds: string[];
  firstPostAt: Date;
  lastPostAt: Date;
  opportunityScore: number;
  opportunityBreakdown: TrendOpportunityBreakdown;
  timing: TrendTiming;
};

export const WINDOW_HOURS = 24;
export const OBSERVATION_DAYS = 7;
/** A trend needs at least this many distinct posts and authors in the observation period */
export const MIN_POSTS = 3;
export const MIN_AUTHORS = 2;
/** Posts the scoring found irrelevant don't count */
export const MIN_POST_SCORE = 20;

const GENERIC_LABELS = new Set(["general", "other", "misc", "miscellaneous", "none", "n a", "unknown", "personal", "random"]);
const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i if in into is it its just like me my no not of on or our so that the their them there they this to up was we what when which who will with you your about more than then also been can do does how just one out some very would could should get got make new now any all".split(
    " ",
  ),
);

const HOUR = 3_600_000;

/** Label → comparable form: lowercase words, punctuation removed, simple plurals folded */
export function normalizeLabel(label: string): string {
  return tokens(label).join(" ");
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word && !STOPWORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/** Post text without links, mentions and punctuation: catches copy-paste duplicates */
export function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)@\w+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

/** Labels that say the same thing ("AI coding tools" / "AI coding tool") share a cluster */
export function clusterLabels(labels: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const label of labels) {
    const key = normalizeLabel(label);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const clusters: { key: string; words: Set<string> }[] = [];
  const assignment = new Map<string, string>();
  for (const [key] of [...counts].sort((a, b) => b[1] - a[1])) {
    const words = new Set(key.split(" "));
    const match = clusters.find((cluster) => jaccard(cluster.words, words) >= 0.6);
    if (match) assignment.set(key, match.key);
    else {
      clusters.push({ key, words });
      assignment.set(key, key);
    }
  }
  return assignment;
}

export function classifyMomentum(current: number, previous: number, comparable: boolean, firstPostAt: Date, now: Date): {
  status: TrendStatus;
  growthPct: number | null;
} {
  if (!comparable) {
    // Not enough history to compare: say so instead of calling it a trend
    return { status: now.getTime() - firstPostAt.getTime() <= 2 * WINDOW_HOURS * HOUR ? "newly_detected" : "insufficient_history", growthPct: null };
  }
  // Small but clearly accelerating: from (almost) nothing to several posts
  if (previous <= 1 && current >= 3) return { status: "emerging", growthPct: previous === 0 ? null : Math.round((current - previous) * 100) };
  if (previous === 0) return { status: current >= 2 ? "newly_detected" : "stable", growthPct: null };
  const growthPct = Math.round(((current - previous) / previous) * 100);
  if (current - previous >= 2 && growthPct >= 50) return { status: "rising", growthPct };
  if (previous - current >= 2 && growthPct <= -50) return { status: "declining", growthPct };
  return { status: "stable", growthPct };
}

const MOMENTUM_POINTS: Record<TrendStatus, (growth: number | null) => number> = {
  emerging: () => 22,
  rising: (growth) => Math.min(35, 15 + Math.round((growth ?? 0) / 10)),
  newly_detected: () => 15,
  stable: () => 10,
  declining: () => 3,
  insufficient_history: () => 0,
};

export function buildTrends(posts: TrendPost[], coverage: Coverage, now = new Date()): TrendDraft[] {
  const since = new Date(now.getTime() - OBSERVATION_DAYS * 24 * HOUR);
  // Relevant, labeled, recent posts; copy-paste duplicates once (the best scored)
  const seen = new Map<string, TrendPost>();
  for (const post of posts) {
    if (!post.label || post.score < MIN_POST_SCORE || post.postedAt < since) continue;
    if (GENERIC_LABELS.has(normalizeLabel(post.label))) continue;
    const dedupe = normalizeContent(post.content);
    const existing = seen.get(dedupe);
    if (!existing || existing.score < post.score) seen.set(dedupe, post);
  }
  const usable = [...seen.values()];
  const assignment = clusterLabels(usable.map((post) => post.label!));
  const groups = new Map<string, TrendPost[]>();
  for (const post of usable) {
    const key = assignment.get(normalizeLabel(post.label!));
    if (key) groups.set(key, [...(groups.get(key) ?? []), post]);
  }

  const comparable =
    coverage.collectingSince !== null &&
    coverage.collectingSince.getTime() <= now.getTime() - 2 * WINDOW_HOURS * HOUR &&
    coverage.scansInCurrentWindow > 0 &&
    coverage.scansInPreviousWindow > 0;
  const currentStart = now.getTime() - WINDOW_HOURS * HOUR;
  const previousStart = now.getTime() - 2 * WINDOW_HOURS * HOUR;

  const drafts: TrendDraft[] = [];
  for (const [key, group] of groups) {
    const authors = new Set(group.map((post) => post.authorKey));
    if (group.length < MIN_POSTS || authors.size < MIN_AUTHORS) continue;

    const byScore = [...group].sort((a, b) => b.score - a.score);
    const times = group.map((post) => post.postedAt.getTime());
    const firstPostAt = new Date(Math.min(...times));
    const lastPostAt = new Date(Math.max(...times));
    const current = times.filter((t) => t >= currentStart).length;
    const previous = times.filter((t) => t >= previousStart && t < currentStart).length;
    const { status, growthPct } = classifyMomentum(current, previous, comparable, firstPostAt, now);

    const relevance = Math.round(group.reduce((sum, post) => sum + post.score, 0) / group.length);
    const engagement = group.reduce(
      (sum, post) => sum + (post.metrics?.likes ?? 0) + (post.metrics?.replies ?? 0) + (post.metrics?.reposts ?? 0),
      0,
    );
    const hoursSinceLast = (now.getTime() - lastPostAt.getTime()) / HOUR;
    const breakdown: TrendScoreBreakdown = {
      momentum: MOMENTUM_POINTS[status](growthPct),
      relevance: Math.round((relevance / 100) * 35),
      engagement: Math.min(10, Math.round((Math.log10(1 + engagement) / Math.log10(1001)) * 10)),
      sources: Math.min(10, authors.size * 2),
      freshness: hoursSinceLast <= 6 ? 10 : hoursSinceLast >= 72 ? 0 : Math.round(10 * (1 - (hoursSinceLast - 6) / 66)),
    };
    const confidence: TrendConfidence =
      comparable && group.length >= 10 && authors.size >= 4 ? "high" : group.length >= 5 && authors.size >= 3 ? "medium" : "low";

    const labelCounts = new Map<string, number>();
    for (const post of group) labelCounts.set(post.label!, (labelCounts.get(post.label!) ?? 0) + 1);
    const label = [...labelCounts].sort((a, b) => b[1] - a[1])[0][0];
    const terms = sharedTerms(group, new Set(key.split(" ")));
    const topicCounts = new Map<string, number>();
    for (const post of group) if (post.discoveryTopicId) topicCounts.set(post.discoveryTopicId, (topicCounts.get(post.discoveryTopicId) ?? 0) + 1);

    const opportunity = opportunityParts(group, status, confidence, relevance);
    const opportunityScore = Object.values(opportunity).reduce((sum, value) => sum + value, 0);

    drafts.push({
      opportunityScore,
      opportunityBreakdown: opportunity,
      timing: timingFor({ status, comparable, confidence, opportunityScore, hoursSinceLast, openings: group.filter((p) => p.openOpportunity).length }),
      key,
      label,
      terms,
      summary: `${group.length} posts from ${authors.size} accounts in your scans over the last ${OBSERVATION_DAYS} days${
        terms.length ? `, often mentioning ${terms.join(", ")}` : ""
      }.`,
      why: byScore[0].reason,
      discoveryTopicId: [...topicCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      status,
      confidence,
      score: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
      relevance,
      scoreBreakdown: breakdown,
      momentum: { windowHours: WINDOW_HOURS, current, previous, growthPct, comparable },
      dailyCounts: dailyCounts(times, coverage.collectingSince, now),
      postCount: group.length,
      authorCount: authors.size,
      engagement,
      representativeIds: byScore.slice(0, 5).map((post) => post.id),
      firstPostAt,
      lastPostAt,
    });
  }
  return drafts.sort((a, b) => b.score - a.score);
}

/** Words at least two posts share (beyond the label itself), most common first */
function sharedTerms(group: TrendPost[], labelWords: Set<string>): string[] {
  const counts = new Map<string, number>();
  for (const post of group) {
    for (const word of new Set(tokens(normalizeContent(post.content)))) {
      if (word.length < 4 || labelWords.has(word) || /^\d+$/.test(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([word]) => word);
}

/** Posts per UTC day, only for days Scout was already collecting (no invented zeros before that) */
function dailyCounts(times: number[], collectingSince: Date | null, now: Date): DailyCount[] {
  const days: DailyCount[] = [];
  const firstDay = collectingSince ? collectingSince.toISOString().slice(0, 10) : now.toISOString().slice(0, 10);
  for (let i = OBSERVATION_DAYS - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * HOUR).toISOString().slice(0, 10);
    if (day < firstDay) continue;
    days.push({ day, posts: times.filter((t) => new Date(t).toISOString().slice(0, 10) === day).length });
  }
  return days;
}

const OPPORTUNITY_MOMENTUM: Record<TrendStatus, number> = {
  emerging: 18,
  rising: 20,
  newly_detected: 10,
  stable: 8,
  declining: 2,
  insufficient_history: 0,
};

/**
 * Day 30 Trend Opportunity Score parts: how worthwhile it is for this user to
 * take part. Relevance weighs most; popularity alone can't carry it.
 */
export function opportunityParts(
  group: TrendPost[],
  status: TrendStatus,
  confidence: TrendConfidence,
  relevance: number,
): TrendOpportunityBreakdown {
  const share = (count: number) => count / Math.max(1, group.length);
  return {
    relevance: Math.round((relevance / 100) * 35),
    momentum: OPPORTUNITY_MOMENTUM[status],
    audience: Math.round(share(group.filter((post) => post.shouldEngage).length) * 15),
    conversation: Math.round(share(group.filter((post) => (post.metrics?.replies ?? 0) > 0).length) * 10),
    openings: Math.min(10, group.filter((post) => post.openOpportunity).length * 4),
    confidence: { low: 3, medium: 7, high: 10 }[confidence],
  };
}

/**
 * Act now / worth exploring / monitor / low priority, from what was observed.
 * Never a prediction of a peak; thin data always means "monitor".
 */
export function timingFor(input: {
  status: TrendStatus;
  comparable: boolean;
  confidence: TrendConfidence;
  opportunityScore: number;
  hoursSinceLast: number;
  openings: number;
}): TrendTiming {
  if (input.status === "declining") return input.opportunityScore >= 55 ? "monitor" : "low_priority";
  if (!input.comparable && input.confidence === "low") return input.opportunityScore >= 35 ? "monitor" : "low_priority";
  const active = ["emerging", "rising", "newly_detected"].includes(input.status);
  if (input.opportunityScore >= 65 && input.hoursSinceLast <= 12 && active && input.openings > 0) return "act_now";
  if (input.opportunityScore >= 50) return "worth_exploring";
  if (input.opportunityScore >= 30) return "monitor";
  return "low_priority";
}
