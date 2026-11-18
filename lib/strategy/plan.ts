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
  METRIC_NAME,
  MIN_EXPERIMENT_DAYS,
  MIN_SPAN_DAYS,
  PATTERN_KINDS,
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
  /** First and last of those posts: the period the patterns really cover */
  span90: { first: Date; last: Date } | null;
  /** First and last post of the last 30 days */
  span30: { first: Date; last: Date } | null;
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
const DAY_MS = 86_400_000;
const day = (date: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);

/** Calendar days from the first post to the last, both included */
export function spanDays(span: { first: Date; last: Date }): number {
  return Math.floor((span.last.getTime() - span.first.getTime()) / DAY_MS) + 1;
}

/** "38 posts from Oct 18 to Oct 22 (5 days)" */
function periodText(count: number, span: { first: Date; last: Date }): string {
  const days = spanDays(span);
  return days === 1 ? `${count} posts, all on ${day(span.first)}` : `${count} posts from ${day(span.first)} to ${day(span.last)} (${days} days)`;
}

const RANK: Record<Confidence, number> = { limited: 0, moderate: 1, good: 2 };
const BY_RANK: Confidence[] = ["limited", "moderate", "good"];

/** Sample size sets the confidence (Growth's rule); a short period lowers it one step */
export function timeAwareConfidence(confidence: Confidence, days: number | null): Confidence {
  if (days === null || days >= MIN_SPAN_DAYS) return confidence;
  return BY_RANK[Math.max(0, RANK[confidence] - 1)];
}

const DIMENSION_NAME: Record<Finding["dimension"], string> = {
  topic: "Topic",
  length: "Post length",
  hook: "Opening line",
  goal: "Content goal",
  trend: "Trend-based posts",
  time: "Time of day",
  weekday: "Weekday vs weekend",
};

const median_ = (metric: Finding["metric"], value: number) => (metric === "engagement_rate" ? pct(value, 2) : value >= 100 ? fmt(value) : String(Math.round(value * 10) / 10));

function side(f: Finding): string {
  return `${f.label} posts: median ${median_(f.metric, f.groupMedian)} vs ${median_(f.metric, f.restMedian)} for your other posts (${f.groupN} vs ${f.restN} posts)`;
}

/**
 * Growth findings as evidence. Findings about the same dimension and metric
 * (e.g. "standard length did better on replies" and "short did worse on
 * replies") are one comparison seen from both sides: merged into one item.
 * Different metrics stay separate. Texts state the real period the posts
 * cover, never "90 days" for a short burst.
 */
export function patternEvidence(findings: Finding[], analyzed: { count: number; span: { first: Date; last: Date } } | null) {
  const days = analyzed ? spanDays(analyzed.span) : null;
  const period = analyzed ? periodText(analyzed.count, analyzed.span) : null;
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = finding.kind === "interaction_gap" ? `gap|${finding.dimension}|${finding.group}` : `${finding.dimension}|${finding.metric}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.values()].slice(0, 6).map((members): Omit<EvidenceItem, "id"> => {
    const confidence = timeAwareConfidence(
      members.map((f) => f.confidence).sort((a, b) => RANK[a] - RANK[b])[0],
      days,
    );
    const metric = members[0].metric;
    // One or two weak posts never justify doing less: Growth's weak threshold, more than "limited"
    const supportsReduction = confidence !== "limited" && members.some((f) => f.kind !== "works" && f.groupN >= MIN_WEAK_GROUP);
    const suffix = period ? ` Based on ${period}.` : "";
    const sample = members[0].totalN;
    if (members[0].kind === "interaction_gap") {
      const f = members[0];
      return {
        kind: "weak",
        text: `${f.label} posts got more impressions but a lower engagement rate: median engagement rate ${pct(f.groupMedian, 2)} vs ${pct(f.restMedian, 2)} for your other posts (${f.groupN} vs ${f.restN} posts).${suffix}`,
        source: "growth",
        sampleSize: sample,
        confidence,
        supportsReduction,
        metric: "engagement_rate",
      };
    }
    if (members.length === 1) {
      const f = members[0];
      const better = f.kind === "works";
      return {
        kind: better ? "works" : "weak",
        text: `${capitalize(f.label)} posts did ${better ? "better" : "worse"} on ${METRIC_NAME[metric]}: ${side(f).split(": ")[1]}.${suffix}`,
        source: "growth",
        sampleSize: sample,
        confidence,
        supportsReduction,
        metric,
      };
    }
    const ordered = [...members].sort((a, b) => b.groupMedian - a.groupMedian);
    return {
      kind: "comparison",
      text: `${DIMENSION_NAME[members[0].dimension]}, ${METRIC_NAME[metric]}: ${ordered.map(side).join("; ")}. One comparison seen from ${ordered.length} sides, not separate findings.${suffix}`,
      source: "growth",
      sampleSize: sample,
      confidence,
      supportsReduction,
      metric,
    };
  });
}

const capitalize = (text: string) => (text.startsWith('"') ? text : text.charAt(0).toUpperCase() + text.slice(1));

/**
 * The observations a strategy may cite, what's missing, and whether there's
 * enough history for an evidence-based plan (else: a labeled starter plan).
 */
export function buildEvidence(input: EvidenceInput): StrategyEvidence {
  const items: EvidenceItem[] = [];
  const add = (item: Omit<EvidenceItem, "id">) => items.push({ ...item, id: `E${items.length + 1}` });
  const missing: string[] = [];

  const analyzed = input.span90 ? { count: input.postsWithImpressions90, span: input.span90 } : null;
  for (const item of patternEvidence(input.findings, analyzed)) add(item);

  if (input.hasAccount) {
    const before =
      input.postsPrevious30 === null ? "" : input.postsPrevious30 === 0 ? " None in the 30 days before either." : ` ${input.postsPrevious30} in the 30 days before.`;
    const noPrevious = input.postsPrevious30 === null ? " Scout doesn't hold the full 30 days before, so there's no comparison." : before;
    const days30 = input.span30 ? spanDays(input.span30) : null;
    // A weekly average only when the posts are spread over most of the period
    const cadence =
      input.posts30 === 0
        ? `No posts in the last 30 days.${before}`
        : days30 !== null && days30 < MIN_SPAN_DAYS
          ? `You published ${input.posts30} posts (replies included) in the last 30 days, all ${days30 === 1 ? `on ${day(input.span30!.first)}` : `between ${day(input.span30!.first)} and ${day(input.span30!.last)} (${days30} days)`}: too short a stretch for a weekly average.${noPrevious}`
          : `You published ${input.posts30} posts (replies included) in the last 30 days, about ${(input.posts30 / 4.3).toFixed(1)} a week.${noPrevious}`;
    add({ kind: "metric", text: cadence, source: "growth", sampleSize: input.posts30, confidence: null, supportsReduction: false });

    const o = input.overview30;
    if (o && o.medianImpressions !== null) {
      const rate = o.engagementRate.value;
      add({
        kind: "metric",
        text: `Last 30 days: median ${fmt(o.medianImpressions)} impressions per post over ${o.postsWithImpressions} posts with impressions${input.span30 ? ` (published ${day(input.span30.first)}–${day(input.span30.last)})` : ""}${rate !== null ? `, engagement rate ${pct(rate, 2)}` : ""}${o.engagementRate.change !== null ? ` (${o.engagementRate.change >= 0 ? "+" : ""}${pct(o.engagementRate.change, 0)} vs the previous 30 days)` : ""}.`,
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
  if (enough && input.span90 && spanDays(input.span90) < MIN_SPAN_DAYS) {
    const days = spanDays(input.span90);
    missing.push(
      `Your analyzed posts cover only ${days} ${days === 1 ? "day" : "days"} (${day(input.span90.first)}–${day(input.span90.last)}): patterns may reflect that stretch, not your usual performance. Confidence stays lower until they cover ${MIN_SPAN_DAYS}+ days.`,
    );
  }
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
  toTest: { text: string; evidenceIds: string[] }[];
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

/** Most minutes one day may take: the week's time spread over at least three days */
export function maxMinutesPerDay(weeklyMinutes: number): number {
  return Math.max(30, Math.ceil(weeklyMinutes / 3));
}

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
  const cited = (ids: string[]) => ids.map((id) => byId.get(id)!);
  const isPattern = (id: string) => PATTERN_KINDS.includes(byId.get(id)!.kind);
  /** Metrics of the cited patterns: what the recommendation is actually about */
  const measuredBy = (ids: string[]) => [...new Set(cited(ids).flatMap((item) => (item.metric ? [METRIC_NAME[item.metric]] : [])))];
  /** Backed by more than limited patterns: a pattern with moderate+ confidence, or a non-pattern observation */
  const solid = (ids: string[]) => ids.some((id) => !isPattern(id) || byId.get(id)!.confidence !== "limited");
  // Impressions and replies aren't follower growth: a follower claim needs follower evidence
  const followerClaimOk = (text: string, ids: string[]) => !/follower/i.test(text) || cited(ids).some((item) => /follower/i.test(item.text));
  const recommendation = (r: { text: string; evidenceIds: string[] }): Recommendation => {
    const ids = cite(r.evidenceIds);
    const metrics = measuredBy(ids);
    return { text: clip(r.text, 300), evidenceIds: ids, ...(metrics.length && { measuredBy: metrics }) };
  };

  const priorities: Priority[] = raw.priorities
    .map((p) => {
      const ids = cite(p.evidenceIds);
      const metrics = measuredBy(ids);
      return {
        title: clip(p.title, 120),
        why: clip(p.why, 400),
        evidenceIds: ids,
        basis: ids.length > 0 && !solid(ids) ? ("hypothesis" as const) : ("evidence" as const),
        ...(metrics.length && { measuredBy: metrics }),
      };
    })
    // Evidence plans cite their reasons; a starter plan is labeled as such instead
    .filter((p) => p.title && (starter || p.evidenceIds.length > 0) && followerClaimOk(`${p.title} ${p.why}`, p.evidenceIds))
    .slice(0, 3);
  if (priorities.length === 0) return null;

  // "Do more" only on solid evidence; positive patterns with limited confidence become hypotheses to test
  const positive = [...raw.doMore, ...raw.toTest]
    .map(recommendation)
    .filter((r) => r.text && r.evidenceIds.length > 0 && followerClaimOk(r.text, r.evidenceIds));
  const doMore = positive.filter((r) => solid(r.evidenceIds)).slice(0, 4);
  const toTest = positive.filter((r) => !solid(r.evidenceIds)).slice(0, 3);
  const doLess: Recommendation[] = starter
    ? []
    : raw.doLess
        .map(recommendation)
        .filter((r) => r.text && r.evidenceIds.some((id) => byId.get(id)!.supportsReduction) && followerClaimOk(r.text, r.evidenceIds))
        .slice(0, 3);

  // Tasks: spread over the week instead of cutting the last days. Round-robin
  // by day (each day's first task, then each day's second), within the
  // weekly time, the daily maximum and 2 tasks a day. Empty days stay rest days.
  const dailyMax = maxMinutesPerDay(weeklyMinutes);
  const byDay = new Map<number, RawStrategy["tasks"]>();
  for (const t of raw.tasks) {
    const d = Math.trunc(t.day);
    if (d < 0 || d > 6 || !(STRATEGY_MODULES as readonly string[]).includes(t.module) || !clip(t.title, 120)) continue;
    byDay.set(d, [...(byDay.get(d) ?? []), t]);
  }
  const effortOf = (t: RawStrategy["tasks"][number]) => Math.min(90, Math.max(5, Math.round(t.effortMinutes / 5) * 5 || 15));
  const dayMinutes = new Map<number, number>();
  const picked: { t: RawStrategy["tasks"][number]; day: number; slot: number }[] = [];
  let minutes = 0;
  for (let slot = 0; slot < MAX_TASKS_PER_DAY; slot++) {
    for (let d = 0; d <= 6; d++) {
      const t = byDay.get(d)?.[slot];
      if (!t || picked.length >= MAX_TASKS) continue;
      const effort = effortOf(t);
      if (minutes + effort > weeklyMinutes || (dayMinutes.get(d) ?? 0) + effort > dailyMax) continue;
      minutes += effort;
      dayMinutes.set(d, (dayMinutes.get(d) ?? 0) + effort);
      picked.push({ t, day: d, slot });
    }
  }
  const position = new Map<number, number>();
  const tasks: ValidTask[] = picked
    .sort((a, b) => a.day - b.day || a.slot - b.slot)
    .map(({ t, day: d }) => {
      position.set(d, (position.get(d) ?? 0) + 1);
      return {
        day: d,
        position: position.get(d)!,
        title: clip(t.title, 120),
        objective: clip(t.objective, 200),
        activity: clip(t.activity, 400),
        reason: clip(t.reason, 300),
        effortMinutes: effortOf(t),
        module: t.module as StrategyModule,
        evidenceIds: cite(t.evidenceIds),
      };
    });

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
      durationDays: Math.min(42, Math.max(MIN_EXPERIMENT_DAYS, Math.round(e.durationDays) || 21)),
      minPerVariant: EXPERIMENT_MIN_PER_VARIANT,
      actions: e.actions.map((a) => clip(a, 200)).filter(Boolean).slice(0, 4),
    });
  }

  const activeIds = new Set(activeExperiments.map((e) => e.id));
  const experimentReviews: ExperimentReview[] = raw.experimentReviews
    .filter((r) => activeIds.has(r.experimentId) && ["continue", "modify", "stop"].includes(r.recommendation))
    .map((r) => ({ experimentId: r.experimentId, recommendation: r.recommendation as ExperimentReview["recommendation"], reason: clip(r.reason, 300) }));

  return {
    content: { summary: clip(raw.summary, 600), priorities, doMore, toTest, doLess, experimentReviews },
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
