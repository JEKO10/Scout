// Day 34 Growth Strategist, the parts that need no database or AI: turning
// stored analytics into citable evidence, validating what the AI proposes
// against that evidence, and measuring experiments. Every number shown to
// the user is computed here, never by the language model.

import {
  type Confidence,
  engagementRate,
  type Finding,
  type GrowthPost,
  hookType,
  lengthBucket,
  median,
  MIN_TOTAL,
  MIN_WEAK_GROUP,
  type Overview,
  type PrivateMetricsSummary,
  timeOfDay,
} from "@/lib/growth/analyze";

import {
  type EvidenceItem,
  EXPERIMENT_DIMENSIONS,
  EXPERIMENT_METRICS,
  EXPERIMENT_MIN_PER_VARIANT,
  type ExperimentDimension,
  type ExperimentMetric,
  type ExperimentResult,
  type ExperimentReview,
  MEASURABLE_VARIANTS,
  type Priority,
  type Recommendation,
  STRATEGY_MODULES,
  type StrategyContent,
  type StrategyEvidence,
  type StrategyModule,
  type StrategySnapshot,
} from "./types";

// ---- Evidence --------------------------------------------------------------------

export type EvidenceInput = {
  hasAccount: boolean;
  handle: string | null;
  /** Growth findings over the last 90 days (already thresholded by Growth) */
  findings: Finding[];
  /** Posts of the last 90 days with impressions: what patterns can rest on */
  postsWithImpressions90: number;
  overview30: Overview | null;
  posts30: number;
  /** null: Scout doesn't hold the whole previous period */
  postsPrevious30: number | null;
  replyActivity30: { opportunities: number; generated: number; opened: number; confirmed: number };
  privateMetrics: PrivateMetricsSummary | null;
  xConnected: boolean;
  trends: { label: string; status: string; postCount: number; authorCount: number }[];
  leads: { highIntentNew: number; total: number };
  content: { readyDrafts: number; plannedNext7: number; confirmedLast30: number };
  previousSnapshot: StrategySnapshot | null;
};

const fmt = (value: number) => Math.round(value).toLocaleString("en-US");
const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;

/**
 * The observations a strategy may cite, what's missing, and whether there's
 * enough history for an evidence-based plan (else: a labeled starter plan).
 */
export function buildEvidence(input: EvidenceInput): StrategyEvidence {
  const items: EvidenceItem[] = [];
  const add = (item: Omit<EvidenceItem, "id">) => items.push({ ...item, id: `E${items.length + 1}` });
  const missing: string[] = [];

  for (const finding of input.findings.slice(0, 6)) {
    const works = finding.kind === "works";
    add({
      kind: works ? "works" : "weak",
      text: `${finding.text} ${finding.evidence}`,
      source: "growth",
      sampleSize: finding.totalN,
      confidence: finding.confidence,
      // One or two weak posts never justify doing less: Growth's weak threshold, and more than "limited"
      supportsReduction: !works && finding.groupN >= MIN_WEAK_GROUP && finding.confidence !== "limited",
    });
  }

  if (input.hasAccount) {
    const cadence =
      input.postsPrevious30 === null
        ? `You published ${input.posts30} posts (replies included) in the last 30 days, about ${(input.posts30 / 4.3).toFixed(1)} a week. Scout doesn't hold the full 30 days before, so there's no comparison.`
        : `You published ${input.posts30} posts (replies included) in the last 30 days, about ${(input.posts30 / 4.3).toFixed(1)} a week, vs ${input.postsPrevious30} in the 30 days before.`;
    add({ kind: "metric", text: cadence, source: "growth", sampleSize: input.posts30, confidence: null, supportsReduction: false });

    const o = input.overview30;
    if (o && o.medianImpressions !== null) {
      const rate = o.engagementRate.value;
      add({
        kind: "metric",
        text: `Last 30 days: median ${fmt(o.medianImpressions)} impressions per post over ${o.postsWithImpressions} posts with impressions${rate !== null ? `, engagement rate ${pct(rate, 2)}` : ""}${o.engagementRate.change !== null ? ` (${o.engagementRate.change >= 0 ? "+" : ""}${pct(o.engagementRate.change, 0)} vs the previous 30 days)` : ""}.`,
        source: "growth",
        sampleSize: o.postsWithImpressions,
        confidence: null,
        supportsReduction: false,
      });
    }
    if (o?.followers.current !== null && o?.followers.current !== undefined) {
      add({
        kind: "metric",
        text: o.followers.net !== null ? `Followers: ${fmt(o.followers.current)}, ${o.followers.net >= 0 ? "+" : ""}${o.followers.net} since ${o.followers.since}.` : `Followers: ${fmt(o.followers.current)} (one reading so far, no change measured yet).`,
        source: "growth",
        sampleSize: null,
        confidence: null,
        supportsReduction: false,
      });
    } else {
      missing.push("No follower readings yet: follower growth can't be measured.");
    }
  } else {
    missing.push("No X account synced: Scout has none of your posts or their numbers.");
  }

  const r = input.replyActivity30;
  if (r.opportunities > 0 || r.generated > 0) {
    add({
      kind: "activity",
      text: `Last 30 days: Scout found ${r.opportunities} conversations worth joining; you drafted ${r.generated} replies and opened ${r.opened} on X (${r.confirmed} confirmed posted).`,
      source: "opportunities",
      sampleSize: r.opportunities,
      confidence: null,
      supportsReduction: false,
    });
  } else {
    missing.push("No conversation activity in the last 30 days: run a scan to find conversations to join.");
  }

  const pm = input.privateMetrics;
  if (pm && pm.covered > 0 && (pm.profileClicks !== null || pm.linkClicks !== null)) {
    add({
      kind: "metric",
      text: `X private metrics on ${pm.covered} of ${pm.total} recent posts: ${pm.profileClicks !== null ? `${fmt(pm.profileClicks)} profile clicks` : "profile clicks unknown"}, ${pm.linkClicks !== null ? `${fmt(pm.linkClicks)} link clicks` : "link clicks unknown"}.`,
      source: "growth",
      sampleSize: pm.covered,
      confidence: null,
      supportsReduction: false,
    });
  } else if (!input.xConnected) {
    missing.push("X isn't connected: profile clicks and link clicks are unknown.");
  }

  for (const trend of input.trends.slice(0, 3)) {
    add({
      kind: "trend",
      text: `Trend in your niche: "${trend.label}" is ${trend.status.replace("_", " ")} (${trend.postCount} posts from ${trend.authorCount} accounts Scout saw).`,
      source: "trends",
      sampleSize: trend.postCount,
      confidence: null,
      supportsReduction: false,
    });
  }
  if (input.trends.length === 0) missing.push("No rising trends detected in your niche yet.");

  if (input.leads.highIntentNew > 0) {
    add({
      kind: "lead",
      text: `${input.leads.highIntentNew} high-intent leads are still new in your CRM (not contacted).`,
      source: "leads",
      sampleSize: input.leads.highIntentNew,
      confidence: null,
      supportsReduction: false,
    });
  }

  const c = input.content;
  if (c.readyDrafts > 0 || c.plannedNext7 > 0 || c.confirmedLast30 > 0) {
    add({
      kind: "content",
      text: `Content Studio: ${c.readyDrafts} drafts ready, ${c.plannedNext7} planned for the next 7 days, ${c.confirmedLast30} marked posted in the last 30 days.`,
      source: "studio",
      sampleSize: null,
      confidence: null,
      supportsReduction: false,
    });
  }

  const enough = input.postsWithImpressions90 >= MIN_TOTAL;
  if (input.hasAccount && !enough) {
    missing.push(
      `Only ${input.postsWithImpressions90} posts with impressions in the last 90 days: too few to compare topics, formats or posting times (needs ${MIN_TOTAL}+).`,
    );
  } else if (enough && input.findings.length === 0) {
    missing.push("No pattern in your posts passed Scout's thresholds (5+ posts per group and a 25%+ difference): nothing clearly works better or worse yet.");
  }

  const snapshot: StrategySnapshot = {
    postsLast30: input.posts30,
    postsPrevious30: input.postsPrevious30,
    medianImpressions: input.overview30?.medianImpressions ?? null,
    engagementRate: input.overview30?.engagementRate.value ?? null,
    followers: input.overview30?.followers.current ?? null,
    repliesOpened: r.opened,
  };

  return {
    items,
    missing,
    mode: enough ? "evidence" : "starter",
    snapshot,
    changes: input.previousSnapshot ? compareSnapshots(input.previousSnapshot, snapshot) : [],
  };
}

/** What moved between two strategies, in words (computed, not AI) */
export function compareSnapshots(before: StrategySnapshot, after: StrategySnapshot): string[] {
  const changes: string[] = [];
  if (before.postsLast30 !== after.postsLast30) {
    changes.push(`Posts in the last 30 days: ${before.postsLast30} → ${after.postsLast30}.`);
  }
  if (before.medianImpressions !== null && after.medianImpressions !== null && before.medianImpressions > 0) {
    const shift = (after.medianImpressions - before.medianImpressions) / before.medianImpressions;
    if (Math.abs(shift) >= 0.1) {
      changes.push(`Median impressions per post: ${fmt(before.medianImpressions)} → ${fmt(after.medianImpressions)} (${shift >= 0 ? "+" : ""}${pct(shift, 0)}).`);
    }
  }
  if (before.engagementRate !== null && after.engagementRate !== null && Math.abs(after.engagementRate - before.engagementRate) >= 0.001) {
    changes.push(`Engagement rate: ${pct(before.engagementRate, 2)} → ${pct(after.engagementRate, 2)}.`);
  }
  if (before.followers !== null && after.followers !== null && before.followers !== after.followers) {
    const net = after.followers - before.followers;
    changes.push(`Followers: ${fmt(before.followers)} → ${fmt(after.followers)} (${net >= 0 ? "+" : ""}${net}).`);
  }
  if (before.repliesOpened !== after.repliesOpened) {
    changes.push(`Replies opened on X (30 days): ${before.repliesOpened} → ${after.repliesOpened}.`);
  }
  return changes;
}

// ---- Validating the AI's proposal ------------------------------------------------

/** What the AI returns (after the zod schema), before Scout's checks */
export type RawStrategy = {
  summary: string;
  priorities: { title: string; why: string; evidenceIds: string[] }[];
  doMore: { text: string; evidenceIds: string[] }[];
  doLess: { text: string; evidenceIds: string[] }[];
  tasks: {
    day: number;
    title: string;
    objective: string;
    activity: string;
    reason: string;
    effortMinutes: number;
    module: string;
    evidenceIds: string[];
  }[];
  experiments: {
    title: string;
    hypothesis: string;
    dimension: string;
    variantA: string;
    variantB: string;
    metric: string;
    durationDays: number;
    actions: string[];
  }[];
  experimentReviews: { experimentId: string; recommendation: string; reason: string }[];
};

export type ValidTask = {
  day: number;
  position: number;
  title: string;
  objective: string;
  activity: string;
  reason: string;
  effortMinutes: number;
  module: StrategyModule;
  evidenceIds: string[];
};

export type ValidExperiment = {
  title: string;
  hypothesis: string;
  dimension: ExperimentDimension;
  variantA: string;
  variantB: string;
  metric: ExperimentMetric;
  durationDays: number;
  minPerVariant: number;
  actions: string[];
};

export const MAX_TASKS_PER_DAY = 2;
export const MAX_TASKS = 10;
export const MAX_NEW_EXPERIMENTS = 2;

const clip = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Keeps only what the evidence supports: unknown evidence IDs are removed,
 * "do more" needs evidence, "do less" needs a weak pattern over enough posts,
 * tasks fit the user's weekly time and link only to known modules, and
 * experiments use variants Scout can measure (or are marked manual).
 * Returns null when nothing usable is left.
 */
export function validateStrategy(
  raw: RawStrategy,
  {
    evidence,
    weeklyMinutes,
    activeExperiments,
  }: {
    evidence: StrategyEvidence;
    weeklyMinutes: number;
    activeExperiments: { id: string; dimension: string; variantA: string; variantB: string }[];
  },
): { content: StrategyContent; tasks: ValidTask[]; experiments: ValidExperiment[] } | null {
  const byId = new Map(evidence.items.map((item) => [item.id, item]));
  const cite = (ids: string[]) => [...new Set(ids.filter((id) => byId.has(id)))];
  const starter = evidence.mode === "starter";

  const priorities: Priority[] = raw.priorities
    .map((p) => ({ title: clip(p.title, 120), why: clip(p.why, 400), evidenceIds: cite(p.evidenceIds) }))
    // Evidence plans cite their reasons; a starter plan is labeled as such instead
    .filter((p) => p.title && (starter || p.evidenceIds.length > 0))
    .slice(0, 3);
  if (priorities.length === 0) return null;

  const doMore: Recommendation[] = raw.doMore
    .map((r) => ({ text: clip(r.text, 300), evidenceIds: cite(r.evidenceIds) }))
    .filter((r) => r.text && r.evidenceIds.length > 0)
    .slice(0, 4);
  const doLess: Recommendation[] = starter
    ? []
    : raw.doLess
        .map((r) => ({ text: clip(r.text, 300), evidenceIds: cite(r.evidenceIds) }))
        .filter((r) => r.text && r.evidenceIds.some((id) => byId.get(id)!.supportsReduction))
        .slice(0, 3);

  const perDay = new Map<number, number>();
  let minutes = 0;
  const tasks: ValidTask[] = [];
  for (const t of [...raw.tasks].sort((a, b) => a.day - b.day)) {
    const day = Math.trunc(t.day);
    if (day < 0 || day > 6) continue;
    if (!(STRATEGY_MODULES as readonly string[]).includes(t.module)) continue;
    if ((perDay.get(day) ?? 0) >= MAX_TASKS_PER_DAY || tasks.length >= MAX_TASKS) continue;
    const effort = Math.min(90, Math.max(5, Math.round(t.effortMinutes / 5) * 5 || 15));
    if (minutes + effort > weeklyMinutes) continue;
    const title = clip(t.title, 120);
    if (!title) continue;
    minutes += effort;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    tasks.push({
      day,
      position: perDay.get(day)!,
      title,
      objective: clip(t.objective, 200),
      activity: clip(t.activity, 400),
      reason: clip(t.reason, 300),
      effortMinutes: effort,
      module: t.module as StrategyModule,
      evidenceIds: cite(t.evidenceIds),
    });
  }

  const running = new Set(activeExperiments.map((e) => `${e.dimension}:${e.variantA}:${e.variantB}`));
  const experiments: ValidExperiment[] = [];
  for (const e of raw.experiments) {
    if (experiments.length >= MAX_NEW_EXPERIMENTS) break;
    if (!(EXPERIMENT_DIMENSIONS as readonly string[]).includes(e.dimension)) continue;
    if (!(EXPERIMENT_METRICS as readonly string[]).includes(e.metric)) continue;
    const dimension = e.dimension as ExperimentDimension;
    const variantA = dimension === "custom" ? clip(e.variantA, 80) : e.variantA;
    const variantB = dimension === "custom" ? clip(e.variantB, 80) : e.variantB;
    if (!variantA || !variantB || variantA === variantB) continue;
    if (dimension !== "custom") {
      const known = MEASURABLE_VARIANTS[dimension];
      if (!(variantA in known) || !(variantB in known)) continue;
    }
    if (running.has(`${dimension}:${variantA}:${variantB}`)) continue;
    experiments.push({
      title: clip(e.title, 120),
      hypothesis: clip(e.hypothesis, 300),
      dimension,
      variantA,
      variantB,
      metric: e.metric as ExperimentMetric,
      durationDays: Math.min(42, Math.max(7, Math.round(e.durationDays) || 21)),
      minPerVariant: EXPERIMENT_MIN_PER_VARIANT,
      actions: e.actions.map((a) => clip(a, 200)).filter(Boolean).slice(0, 4),
    });
  }

  const activeIds = new Set(activeExperiments.map((e) => e.id));
  const experimentReviews: ExperimentReview[] = raw.experimentReviews
    .filter((r) => activeIds.has(r.experimentId) && ["continue", "modify", "stop"].includes(r.recommendation))
    .map((r) => ({ experimentId: r.experimentId, recommendation: r.recommendation as ExperimentReview["recommendation"], reason: clip(r.reason, 300) }));

  return {
    content: { summary: clip(raw.summary, 600), priorities, doMore, doLess, experimentReviews },
    tasks,
    experiments,
  };
}

// ---- Experiments -----------------------------------------------------------------

function metricValue(post: GrowthPost, metric: ExperimentMetric): number | null {
  if (metric === "impressions") return post.impressions;
  if (metric === "replies") return post.replies;
  return engagementRate(post);
}

function variantOf(post: GrowthPost, dimension: Exclude<ExperimentDimension, "custom">, tz: string): string {
  if (dimension === "length") return lengthBucket(post.text);
  if (dimension === "hook") return hookType(post.text);
  return timeOfDay(post.publishedAt, tz);
}

/**
 * An experiment's result from the user's own posts published while it ran.
 * Medians per variant, shown only with enough posts in both, and always as
 * directional: small samples can't prove a difference, and topics, news and
 * timing change alongside.
 */
export function experimentResult(
  experiment: { dimension: string; variantA: string; variantB: string; metric: string; minPerVariant: number; startedAt: Date | null; endsAt: Date | null },
  posts: GrowthPost[],
  { tz, now = new Date() }: { tz: string; now?: Date },
): ExperimentResult {
  if (experiment.dimension === "custom") {
    return { status: "manual", note: "Scout can't tell these variants apart from post data: record what you see in your observations." };
  }
  if (!experiment.startedAt) return { status: "not_started" };
  const dimension = experiment.dimension as Exclude<ExperimentDimension, "custom">;
  const metric = experiment.metric as ExperimentMetric;
  const end = experiment.endsAt && experiment.endsAt < now ? experiment.endsAt : now;
  const values = { a: [] as number[], b: [] as number[] };
  for (const post of posts) {
    if (post.kind === "reply" || post.publishedAt < experiment.startedAt || post.publishedAt > end) continue;
    const value = metricValue(post, metric);
    if (value === null) continue;
    const variant = variantOf(post, dimension, tz);
    if (variant === experiment.variantA) values.a.push(value);
    else if (variant === experiment.variantB) values.b.push(value);
  }
  const needed = experiment.minPerVariant;
  if (values.a.length < needed || values.b.length < needed) {
    return { status: "collecting", aN: values.a.length, bN: values.b.length, needed };
  }
  const aMedian = median(values.a)!;
  const bMedian = median(values.b)!;
  const smaller = Math.min(values.a.length, values.b.length);
  const confidence: Confidence = smaller >= 15 ? "good" : smaller >= 8 ? "moderate" : "limited";
  return {
    status: "directional",
    aN: values.a.length,
    bN: values.b.length,
    aMedian,
    bMedian,
    difference: bMedian === 0 ? null : (aMedian - bMedian) / bMedian,
    confidence,
    note: `Directional only: ${values.a.length} vs ${values.b.length} posts can't show a statistically significant difference, and topics and timing changed too.`,
  };
}

/** The seven local dates of a plan starting on `start` (YYYY-MM-DD) */
export function planDays(start: string): string[] {
  const [y, m, d] = start.split("-").map(Number);
  return Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}
