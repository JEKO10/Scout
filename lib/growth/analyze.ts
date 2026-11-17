// Day 33 Growth Intelligence: deterministic analytics over stored, real data.
// Every number here comes from X's public metrics or Scout's own records. A
// missing metric stays null (never zero), comparisons need minimum samples,
// and findings describe associations, not causes.

import { zonedParts } from "@/lib/content/calendar";
import { type ContentFormat, type ContentGoal, GOAL_LABEL } from "@/lib/content/types";

export type GrowthPost = {
  id: string;
  platformPostId: string;
  url: string | null;
  text: string;
  publishedAt: Date;
  kind: "post" | "reply" | "quote" | null;
  replyToPostId: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
  impressions: number | null;
  source: "x_api" | "csv_import" | null;
  fetchedAt: Date | null;
  /** The Studio draft it was posted from, when the user linked it */
  draft: { id: string; title: string; goal: ContentGoal; format: ContentFormat; fromTrend: boolean } | null;
  topic: string | null;
  topicSource: "studio" | "brain" | "keyword" | null;
  /**
   * X private metrics (OAuth): the latest reading Scout holds. Undefined or
   * null: never read (not connected, or the post was already older than 30
   * days). Never a zero standing in for "unknown".
   */
  profileClicks?: number | null;
  linkClicks?: number | null;
  /** X's own engagements count (all interactions, clicks included) */
  xEngagements?: number | null;
  privateFetchedAt?: Date | null;
};

export type Snapshot = { day: string; followers: number | null };

// ---- Definitions -------------------------------------------------------------

/** likes + replies + reposts (quotes included); null if X didn't report one of them */
export function engagement(post: Pick<GrowthPost, "likes" | "replies" | "reposts">): number | null {
  if (post.likes === null || post.replies === null || post.reposts === null) return null;
  return post.likes + post.replies + post.reposts;
}

/** Only with impressions: a rate is never invented for a post without them */
export function engagementRate(post: GrowthPost): number | null {
  const eng = engagement(post);
  return post.impressions && post.impressions > 0 && eng !== null ? eng / post.impressions : null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const nums = (values: (number | null)[]) => values.filter((value): value is number => value !== null);
const isOriginal = (post: GrowthPost) => post.kind !== "reply";

export function lengthBucket(text: string): "short" | "standard" | "long" {
  const length = [...text].length;
  return length <= 100 ? "short" : length <= 280 ? "standard" : "long";
}

/** The opening line's shape, by simple rules (no AI) */
export function hookType(text: string): "question" | "number" | "how_why" | "statement" {
  const first = text.trim().split("\n")[0].trim();
  if (first.endsWith("?")) return "question";
  if (/^\d/.test(first)) return "number";
  if (/^(how|why|what)\b/i.test(first)) return "how_why";
  return "statement";
}

export function timeOfDay(date: Date, tz: string): "morning" | "afternoon" | "evening" | "night" {
  const hour = Number(zonedParts(date, tz).time.slice(0, 2));
  return hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night";
}

function isWeekend(date: Date, tz: string): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

const BUCKET_LABEL: Record<string, string> = {
  short: "short (up to 100 characters)",
  standard: "standard-length (101–280 characters)",
  long: "long (over 280 characters)",
  question: "question-hook",
  number: "number-led",
  how_why: "how/why/what-led",
  statement: "statement-hook",
  morning: "morning (5–12h)",
  afternoon: "afternoon (12–17h)",
  evening: "evening (17–22h)",
  night: "night (22–5h)",
  weekend: "weekend",
  weekday: "weekday",
  trend: "trend-based",
  not_trend: "non-trend",
};

// ---- Overview ----------------------------------------------------------------

export type Stat = { value: number | null; previous: number | null; change: number | null };

export type Overview = {
  posts: Stat;
  impressions: Stat;
  engagement: Stat;
  engagementRate: Stat;
  avgImpressions: Stat;
  medianImpressions: number | null;
  postsWithImpressions: number;
  followers: { current: number | null; net: number | null; growth: number | null; previousNet: number | null; since: string | null };
  /** Scout holds every post of the period (its oldest stored post is older than the period) */
  complete: boolean;
  previousComplete: boolean;
};

const change = (value: number | null, previous: number | null) =>
  value === null || previous === null || previous === 0 ? null : (value - previous) / previous;

function periodTotals(posts: GrowthPost[]) {
  const withImpressions = posts.filter((post) => post.impressions !== null);
  const impressions = withImpressions.length ? withImpressions.reduce((sum, post) => sum + post.impressions!, 0) : null;
  const engaged = posts.map(engagement);
  const engagementTotal = nums(engaged).length ? nums(engaged).reduce((a, b) => a + b, 0) : null;
  const rated = withImpressions.filter((post) => engagement(post) !== null);
  const ratedImpressions = rated.reduce((sum, post) => sum + post.impressions!, 0);
  const rate = ratedImpressions > 0 ? rated.reduce((sum, post) => sum + engagement(post)!, 0) / ratedImpressions : null;
  return {
    posts: posts.length,
    impressions,
    engagement: engagementTotal,
    rate,
    avg: impressions !== null ? impressions / withImpressions.length : null,
    median: median(nums(withImpressions.map((post) => post.impressions))),
    withImpressions: withImpressions.length,
  };
}

/** Latest follower reading on or before a day */
function followersAt(snapshots: Snapshot[], day: string): Snapshot | undefined {
  return [...snapshots].reverse().find((snap) => snap.day <= day && snap.followers !== null);
}

export function overview(
  current: GrowthPost[],
  previous: GrowthPost[],
  { complete, previousComplete, snapshots, start, previousStart, now }: {
    complete: boolean;
    previousComplete: boolean;
    snapshots: Snapshot[];
    start: Date;
    previousStart: Date;
    now: Date;
  },
): Overview {
  const a = periodTotals(current);
  const b = previousComplete ? periodTotals(previous) : null;
  const stat = (value: number | null, prev: number | null): Stat => ({ value, previous: prev, change: change(value, prev) });

  const day = (date: Date) => date.toISOString().slice(0, 10);
  const latest = followersAt(snapshots, day(now));
  // Baseline: the last reading before the period, else the first one in it
  const baseline =
    followersAt(snapshots, day(new Date(start.getTime() - 86_400_000))) ??
    snapshots.find((snap) => snap.day >= day(start) && snap.followers !== null);
  const net = latest && baseline && latest.day !== baseline.day ? latest.followers! - baseline.followers! : null;
  const previousBase = followersAt(snapshots, day(new Date(previousStart.getTime() - 86_400_000)));
  const previousEnd = followersAt(snapshots, day(new Date(start.getTime() - 86_400_000)));
  const previousNet =
    previousBase && previousEnd && previousBase.day !== previousEnd.day ? previousEnd.followers! - previousBase.followers! : null;

  return {
    posts: stat(complete ? a.posts : null, b && complete ? b.posts : null),
    impressions: stat(a.impressions, b?.impressions ?? null),
    engagement: stat(a.engagement, b?.engagement ?? null),
    engagementRate: stat(a.rate, b?.rate ?? null),
    avgImpressions: stat(a.avg, b?.avg ?? null),
    medianImpressions: a.median,
    postsWithImpressions: a.withImpressions,
    followers: {
      current: latest?.followers ?? null,
      net,
      growth: net !== null && baseline!.followers ? net / baseline!.followers : null,
      previousNet,
      since: net !== null ? baseline!.day : null,
    },
    complete,
    previousComplete,
  };
}

// ---- Series ------------------------------------------------------------------

export type DayPoint = { day: string; posts: number; impressions: number; engagement: number };

/** Totals by publish day (in the user's zone), only days with posts that have impressions */
export function dailySeries(posts: GrowthPost[], tz: string): DayPoint[] | null {
  const byDay = new Map<string, DayPoint>();
  for (const post of posts) {
    if (post.impressions === null) continue;
    const day = zonedParts(post.publishedAt, tz).date;
    const point = byDay.get(day) ?? { day, posts: 0, impressions: 0, engagement: 0 };
    point.posts++;
    point.impressions += post.impressions;
    point.engagement += engagement(post) ?? 0;
    byDay.set(day, point);
  }
  const points = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return points.length >= 3 && points.reduce((sum, point) => sum + point.posts, 0) >= 5 ? points : null;
}

export function followerSeries(snapshots: Snapshot[]): { day: string; followers: number }[] | null {
  const points = snapshots.filter((snap) => snap.followers !== null).map((snap) => ({ day: snap.day, followers: snap.followers! }));
  return points.length >= 3 ? points : null;
}

// ---- What works / what doesn't ----------------------------------------------

export const MIN_GROUP = 5;
export const MIN_REST = 5;
export const MIN_TOTAL = 10;
/** Weak-pattern findings need more evidence than positive ones */
export const MIN_WEAK_GROUP = 8;
export const MIN_LIFT = 0.25;

export type Confidence = "limited" | "moderate" | "good";
export const CONFIDENCE_LABEL: Record<Confidence, string> = { limited: "Limited", moderate: "Moderate", good: "Good" };

export type GrowthMetric = "impressions" | "engagement_rate" | "replies";
const METRIC_TEXT: Record<GrowthMetric, string> = {
  impressions: "impressions per post",
  engagement_rate: "engagement rate",
  replies: "replies per post",
};

export type Finding = {
  kind: "works" | "weak" | "interaction_gap";
  dimension: "topic" | "length" | "hook" | "goal" | "trend" | "time" | "weekday";
  group: string;
  label: string;
  metric: GrowthMetric;
  groupMedian: number;
  restMedian: number;
  lift: number;
  groupN: number;
  restN: number;
  totalN: number;
  periodDays: number;
  confidence: Confidence;
  examples: GrowthPost[];
  text: string;
  evidence: string;
  action: string;
};

function confidenceFor(groupN: number, restN: number, total: number): Confidence {
  const smaller = Math.min(groupN, restN);
  if (smaller >= 15 && total >= 40) return "good";
  if (smaller >= 8 && total >= 20) return "moderate";
  return "limited";
}

const metricValue = (metric: GrowthMetric, post: GrowthPost): number | null =>
  metric === "impressions" ? post.impressions : metric === "engagement_rate" ? engagementRate(post) : post.replies;

export function formatMetric(metric: GrowthMetric, value: number): string {
  if (metric === "engagement_rate") return `${(value * 100).toFixed(1)}%`;
  return value >= 100 ? Math.round(value).toLocaleString("en-US") : String(Math.round(value * 10) / 10);
}

type Dimension = Finding["dimension"];

type Grouping = { dimension: Dimension; key: (post: GrowthPost) => string | null; studioOnly?: boolean };

function groupsFor(tz: string): Grouping[] {
  return [
    { dimension: "topic", key: (post) => post.topic },
    { dimension: "length", key: (post) => lengthBucket(post.text) },
    { dimension: "hook", key: (post) => hookType(post.text) },
    // Only Studio posts know their goal and whether they came from a trend:
    // compared among Studio posts
    { dimension: "goal", key: (post) => post.draft?.goal ?? null, studioOnly: true },
    { dimension: "trend", key: (post) => (post.draft ? (post.draft.fromTrend ? "trend" : "not_trend") : null), studioOnly: true },
    { dimension: "time", key: (post) => timeOfDay(post.publishedAt, tz) },
    { dimension: "weekday", key: (post) => (isWeekend(post.publishedAt, tz) ? "weekend" : "weekday") },
  ];
}

function groupLabel(dimension: Dimension, group: string): string {
  if (dimension === "topic") return `"${group}"`;
  if (dimension === "goal") return GOAL_LABEL[group as ContentGoal]?.toLowerCase() ?? group;
  return BUCKET_LABEL[group] ?? group;
}

function actionFor(finding: Pick<Finding, "kind" | "dimension" | "label">): string {
  const { kind, dimension, label } = finding;
  if (kind === "interaction_gap") {
    return `Keep the reach of ${label} posts but end them with a clear question or an opinion people can answer.`;
  }
  if (kind === "works") {
    switch (dimension) {
      case "topic":
        return `Plan two more posts about ${label} in the next two weeks and compare them with these.`;
      case "time":
      case "weekday":
        return `Plan a few of next week's posts for the ${label} slot and see whether the pattern holds.`;
      case "goal":
        return `Write two more ${label} posts in Content Studio next week and compare.`;
      default:
        return `Test two more ${label} posts next week and compare their results with these.`;
    }
  }
  switch (dimension) {
    case "topic":
      return `Before dropping ${label}, try a different angle on it: a concrete example or a question to your audience.`;
    case "time":
    case "weekday":
      return `Move a couple of posts out of the ${label} slot for two weeks and compare.`;
    default:
      return `Post fewer ${label} posts for two weeks, or rework their opening, and compare.`;
  }
}

/**
 * Groups that differ from the rest of the user's posts by at least 25% on a
 * median, with enough posts on both sides. Original posts only (replies are
 * a different kind of activity).
 */
export function findPatterns(all: GrowthPost[], { tz, periodDays }: { tz: string; periodDays: number }): Finding[] {
  const posts = all.filter((post) => isOriginal(post) && post.impressions !== null);
  if (posts.length < MIN_TOTAL) return [];
  const findings: Finding[] = [];

  for (const { dimension, key, studioOnly } of groupsFor(tz)) {
    const groups = new Map<string, GrowthPost[]>();
    for (const post of posts) {
      const group = key(post);
      if (group) groups.set(group, [...(groups.get(group) ?? []), post]);
    }
    for (const [group, members] of groups) {
      const rest = posts.filter((post) => key(post) !== group && (!studioOnly || key(post) !== null));
      if (members.length < MIN_GROUP || rest.length < MIN_REST) continue;
      const label = groupLabel(dimension, group);
      const lifts = (["impressions", "engagement_rate", "replies"] as GrowthMetric[]).map((metric) => {
        const groupMedian = median(nums(members.map((post) => metricValue(metric, post))));
        const restMedian = median(nums(rest.map((post) => metricValue(metric, post))));
        const lift = groupMedian !== null && restMedian !== null && restMedian > 0 ? (groupMedian - restMedian) / restMedian : null;
        return { metric, groupMedian, restMedian, lift };
      });
      const base = { dimension, group, label, groupN: members.length, restN: rest.length, totalN: members.length + rest.length, periodDays };
      const confidence = confidenceFor(members.length, rest.length, base.totalN);

      const reach = lifts[0];
      const rate = lifts[1];
      if (reach.lift !== null && rate.lift !== null && reach.lift >= MIN_LIFT && rate.lift <= -MIN_LIFT && members.length >= MIN_WEAK_GROUP) {
        findings.push({
          ...base,
          kind: "interaction_gap",
          metric: "engagement_rate",
          groupMedian: rate.groupMedian!,
          restMedian: rate.restMedian!,
          lift: rate.lift,
          confidence,
          examples: topBy(members, "impressions", 2),
          text: `Your ${label} posts got more impressions but a lower engagement rate than your other posts.`,
          evidence: `${members.length} ${label} posts vs ${rest.length} others over ${periodDays} days: median impressions ${formatMetric("impressions", reach.groupMedian!)} vs ${formatMetric("impressions", reach.restMedian!)}, median engagement rate ${formatMetric("engagement_rate", rate.groupMedian!)} vs ${formatMetric("engagement_rate", rate.restMedian!)}.`,
          action: actionFor({ kind: "interaction_gap", dimension, label }),
        });
        continue;
      }

      const best = lifts.filter((item) => item.lift !== null).sort((x, y) => Math.abs(y.lift!) - Math.abs(x.lift!))[0];
      if (!best || Math.abs(best.lift!) < MIN_LIFT) continue;
      const kind = best.lift! > 0 ? "works" : "weak";
      if (kind === "weak" && members.length < MIN_WEAK_GROUP) continue;
      const pct = Math.round(Math.abs(best.lift!) * 100);
      findings.push({
        ...base,
        kind,
        metric: best.metric,
        groupMedian: best.groupMedian!,
        restMedian: best.restMedian!,
        lift: best.lift!,
        confidence,
        examples: kind === "works" ? topBy(members, best.metric, 2) : bottomBy(members, best.metric, 2),
        text:
          best.metric === "engagement_rate"
            ? `Your ${label} posts had a ${pct}% ${kind === "works" ? "higher" : "lower"} median engagement rate than your other posts over the last ${periodDays} days.`
            : `Your ${label} posts received ${pct}% ${kind === "works" ? "more" : "fewer"} ${METRIC_TEXT[best.metric]} (median) than your other posts over the last ${periodDays} days.`,
        evidence: `${members.length} ${label} posts vs ${rest.length} others: median ${formatMetric(best.metric, best.groupMedian!)} vs ${formatMetric(best.metric, best.restMedian!)}.`,
        action: actionFor({ kind, dimension, label }),
      });
    }
  }
  const strength = (finding: Finding) => Math.abs(finding.lift) * Math.sqrt(finding.groupN);
  return findings.sort((x, y) => strength(y) - strength(x));
}

function topBy(posts: GrowthPost[], metric: GrowthMetric, n: number) {
  return [...posts].sort((a, b) => (metricValue(metric, b) ?? -1) - (metricValue(metric, a) ?? -1)).slice(0, n);
}
function bottomBy(posts: GrowthPost[], metric: GrowthMetric, n: number) {
  return [...posts]
    .filter((post) => metricValue(metric, post) !== null)
    .sort((a, b) => metricValue(metric, a)! - metricValue(metric, b)!)
    .slice(0, n);
}

// ---- Topics --------------------------------------------------------------------

export type TopicRow = {
  topic: string;
  source: GrowthPost["topicSource"];
  posts: number;
  medianImpressions: number | null;
  engagementRate: number | null;
  replies: number | null;
  /** Second half of the period vs the first, median impressions; null: too few posts */
  trend: "up" | "down" | "steady" | null;
};

export function topicTable(all: GrowthPost[], start: Date, end: Date): TopicRow[] {
  const posts = all.filter(isOriginal);
  const groups = new Map<string, GrowthPost[]>();
  for (const post of posts) if (post.topic) groups.set(post.topic, [...(groups.get(post.topic) ?? []), post]);
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  return [...groups.entries()]
    .map(([topic, members]) => {
      const totals = periodTotals(members);
      const early = median(nums(members.filter((post) => post.publishedAt < mid).map((post) => post.impressions)));
      const late = median(nums(members.filter((post) => post.publishedAt >= mid).map((post) => post.impressions)));
      const earlyN = members.filter((post) => post.publishedAt < mid && post.impressions !== null).length;
      const lateN = members.filter((post) => post.publishedAt >= mid && post.impressions !== null).length;
      const shift = early && late !== null && earlyN >= 3 && lateN >= 3 ? (late - early) / early : null;
      return {
        topic,
        source: members[0].topicSource,
        posts: members.length,
        medianImpressions: totals.median,
        engagementRate: totals.rate,
        replies: nums(members.map((post) => post.replies)).length ? nums(members.map((post) => post.replies)).reduce((a, b) => a + b, 0) : null,
        trend: shift === null ? null : shift > 0.2 ? ("up" as const) : shift < -0.2 ? ("down" as const) : ("steady" as const),
      };
    })
    .sort((a, b) => b.posts - a.posts);
}

// ---- Posting time --------------------------------------------------------------

export const POSTING_TIME_MIN_POSTS = 30;
export const POSTING_TIME_MIN_BUCKET = 6;
export const NOT_ENOUGH_FOR_TIMES = "Not enough historical data to identify reliable posting-time patterns.";

export type TimeBucket = { bucket: ReturnType<typeof timeOfDay>; label: string; posts: number; medianImpressions: number | null };

export function postingTimes(all: GrowthPost[], tz: string): { buckets: TimeBucket[]; finding: string | null; analyzed: number } {
  const posts = all.filter((post) => isOriginal(post) && post.impressions !== null);
  const buckets = (["morning", "afternoon", "evening", "night"] as const).map((bucket) => {
    const members = posts.filter((post) => timeOfDay(post.publishedAt, tz) === bucket);
    return { bucket, label: BUCKET_LABEL[bucket], posts: members.length, medianImpressions: median(members.map((post) => post.impressions!)) };
  });
  const usable = buckets.filter((bucket) => bucket.posts >= POSTING_TIME_MIN_BUCKET);
  if (posts.length < POSTING_TIME_MIN_POSTS || usable.length < 2) return { buckets, finding: null, analyzed: posts.length };
  const best = [...usable].sort((a, b) => b.medianImpressions! - a.medianImpressions!)[0];
  const others = median(posts.filter((post) => timeOfDay(post.publishedAt, tz) !== best.bucket).map((post) => post.impressions!));
  if (others === null || others === 0 || (best.medianImpressions! - others) / others < MIN_LIFT) {
    return { buckets, finding: "No posting window stands out: your results look similar across times of day.", analyzed: posts.length };
  }
  return {
    buckets,
    finding: `Your ${best.label} posts (${tz}) had median ${formatMetric("impressions", best.medianImpressions!)} impressions vs ${formatMetric("impressions", others)} for your posts at other times (${best.posts} of ${posts.length} posts). Worth testing, not a rule.`,
    analyzed: posts.length,
  };
}

// ---- Followers vs activity ------------------------------------------------------

/**
 * Week by week: follower change next to what was published. Correlation only:
 * Scout can't see which post brought which follower.
 */
export function followerWeeks(snapshots: Snapshot[], posts: GrowthPost[], now: Date) {
  const weeks: { end: string; net: number; posts: number; topGoal: string | null; topTopic: string | null }[] = [];
  for (let i = 0; i < 13; i++) {
    const end = new Date(now.getTime() - i * 7 * 86_400_000);
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const day = (date: Date) => date.toISOString().slice(0, 10);
    const at = followersAt(snapshots, day(end));
    const from = followersAt(snapshots, day(start));
    // Readings must sit near both ends of the week
    if (!at || !from || at.day === from.day || day(new Date(end.getTime() - 86_400_000)) > at.day || from.day < day(new Date(start.getTime() - 86_400_000))) continue;
    const inWeek = posts.filter((post) => post.publishedAt >= start && post.publishedAt < end && isOriginal(post));
    weeks.push({ end: day(end), net: at.followers! - from.followers!, posts: inWeek.length, topGoal: mostCommon(inWeek.map((post) => post.draft?.goal ?? null)), topTopic: mostCommon(inWeek.map((post) => post.topic)) });
  }
  if (weeks.length < 3) return { weeks, finding: null };
  const best = [...weeks].sort((a, b) => b.net - a.net)[0];
  const typical = median(weeks.map((week) => week.posts));
  const what = best.topTopic ? `, mostly about "${best.topTopic}"` : best.topGoal ? `, mostly ${GOAL_LABEL[best.topGoal as ContentGoal].toLowerCase()} posts` : "";
  const finding =
    best.net > 0
      ? `Follower growth was strongest in the week ending ${best.end} (+${best.net}), when you published ${best.posts} posts${what} (typical week: ${typical}). This shows timing, not cause.`
      : null;
  return { weeks, finding };
}

function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 2 ? top[0] : null;
}

// ---- Replies -------------------------------------------------------------------

/**
 * The user's own replies X returned, and which of them answer posts Scout
 * suggested (the reply's parent matches an opportunity the user opened).
 * That match is the only verification: a confirmation alone is the user's word.
 */
export function replyPerformance(posts: GrowthPost[], repliedToPostIds: string[]) {
  const replies = posts.filter((post) => post.kind === "reply");
  const targets = new Set(repliedToPostIds);
  const viaScout = replies.filter((post) => post.replyToPostId && targets.has(post.replyToPostId));
  const others = replies.filter((post) => !viaScout.includes(post));
  const summary = (list: GrowthPost[]) => ({
    count: list.length,
    medianLikes: median(nums(list.map((post) => post.likes))),
    medianImpressions: median(nums(list.map((post) => post.impressions))),
  });
  return {
    all: summary(replies),
    viaScout: summary(viaScout),
    others: summary(others),
    comparable: viaScout.length >= 3 && others.length >= 3,
  };
}

// ---- Recommendations -----------------------------------------------------------

export type Recommendation = { finding: string; evidence: string; action: string; confidence: string };

export function recommendations(findings: Finding[], limit = 4): Recommendation[] {
  return findings.slice(0, limit).map((finding) => ({
    finding: finding.text,
    evidence: finding.evidence,
    action: finding.action,
    confidence: `${CONFIDENCE_LABEL[finding.confidence]}: based on ${finding.totalN} posts (${finding.groupN} in this group). An association, not proof of cause.`,
  }));
}

// ---- Post list -----------------------------------------------------------------

export const POST_SORTS = ["impressions", "rate", "replies", "recent"] as const;
export type PostSort = (typeof POST_SORTS)[number];

/** Posts without the sorted metric go last, never ranked by a made-up value */
export function sortPosts(posts: GrowthPost[], sort: PostSort): GrowthPost[] {
  const value = (post: GrowthPost) =>
    sort === "impressions" ? post.impressions : sort === "rate" ? engagementRate(post) : sort === "replies" ? post.replies : post.publishedAt.getTime();
  return [...posts].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return b.publishedAt.getTime() - a.publishedAt.getTime();
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  });
}

// ---- X private metrics (OAuth) -----------------------------------------------

export type PrivateMetricsSummary = {
  /** Posts in the period that have a private reading */
  covered: number;
  total: number;
  /** Sums over covered posts only; null when no post has the metric */
  profileClicks: number | null;
  linkClicks: number | null;
  xEngagements: number | null;
  /** The oldest reading among them: how fresh the sums are at worst */
  oldestReadingAt: Date | null;
};

/** Sums of X's private metrics over the posts that have them; nothing is extrapolated */
export function privateMetricsSummary(posts: GrowthPost[]): PrivateMetricsSummary {
  const covered = posts.filter((post) => post.privateFetchedAt);
  const sum = (key: "profileClicks" | "linkClicks" | "xEngagements") => {
    const values = covered.map((post) => post[key]).filter((value): value is number => typeof value === "number");
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const times = covered.map((post) => post.privateFetchedAt!.getTime());
  return {
    covered: covered.length,
    total: posts.length,
    profileClicks: sum("profileClicks"),
    linkClicks: sum("linkClicks"),
    xEngagements: sum("xEngagements"),
    oldestReadingAt: times.length ? new Date(Math.min(...times)) : null,
  };
}
