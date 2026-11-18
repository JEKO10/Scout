// Day 35 Peer Intelligence, the parts that need no database, X or AI:
// how comparable a peer is, which patterns hold inside one peer account,
// how peers' patterns become evidence (never proof for the user), the
// strategy stage, and the four-week roadmap. Deterministic and testable.

import { type Confidence, median, MIN_GROUP, MIN_LIFT, MIN_REST, MIN_TOTAL } from "@/lib/growth/analyze";

import {
  type EvidenceItem,
  METRIC_NAME,
  MIN_SPAN_DAYS,
  PEER_MIN_POSTS,
  type PeerCategory,
  type RoadmapWeek,
  STRATEGY_MODULES,
  type StrategyModule,
  type StrategyObjective,
  type StrategyStage,
} from "./types";

const DAY_MS = 86_400_000;
const day = (date: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);

// ---- Relevance ---------------------------------------------------------------------

const STOPWORDS = new Set(
  "about after again also among another based because been before being build building built could does doing during each every from have having here into just like made make many more most much only other over same should since some such than that their them then there these they this those through very want were what when where which while with within without would your yours".split(" "),
);

/** Lowercase content words (4+ letters) for overlap scoring */
export function keywords(...texts: (string | null | undefined)[]): Set<string> {
  const words = new Set<string>();
  for (const text of texts) {
    for (const word of (text ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) ?? []) {
      if (!STOPWORDS.has(word)) words.add(word.replace(/s$/, ""));
    }
  }
  return words;
}

/** Above this many followers an account is a brand or celebrity: never a direct peer */
export const ASPIRATIONAL_FOLLOWERS = 250_000;

/** Largest follower count still comparable: 20× the user's, at least 10,000 */
export function directPeerCeiling(userFollowers: number | null): number {
  return Math.max(10_000, 20 * (userFollowers ?? 0));
}

export type PeerScore = {
  category: PeerCategory;
  /** 0-100; null parts are left out, never guessed */
  score: number;
  /** Share of the user's keywords found in the peer's bio and matched posts; null: no peer text */
  topicSimilarity: number | null;
  reasons: string[];
};

/**
 * Deterministic comparability. Category comes from size only (followers
 * vs the user's); relevance adds topic overlap and recent activity. Unknown
 * parts stay unknown: a peer without a follower count is "unknown", not direct.
 */
export function scorePeer(
  peer: { followers: number | null; bio: string | null; accountCreatedAt: Date | null },
  {
    userFollowers,
    userKeywords,
    peerTopicPosts,
    postsLast30,
    now = new Date(),
  }: { userFollowers: number | null; userKeywords: Set<string>; peerTopicPosts: number; postsLast30: number | null; now?: Date },
): PeerScore {
  const reasons: string[] = [];
  let category: PeerCategory = "unknown";
  let sizePoints = 0;
  if (peer.followers === null) {
    reasons.push("Follower count unknown: comparability can't be judged.");
  } else if (peer.followers > ASPIRATIONAL_FOLLOWERS || peer.followers > directPeerCeiling(userFollowers)) {
    category = "aspirational";
    reasons.push(`${peer.followers.toLocaleString("en-US")} followers: much larger than you, worth studying but not a benchmark.`);
  } else {
    category = "direct";
    sizePoints = 30;
    reasons.push(`${peer.followers.toLocaleString("en-US")} followers: a comparable size.`);
  }

  const peerWords = keywords(peer.bio);
  let topicSimilarity: number | null = null;
  if (userKeywords.size > 0 && (peerWords.size > 0 || peerTopicPosts > 0)) {
    const shared = [...userKeywords].filter((word) => peerWords.has(word)).length;
    const bioShare = Math.min(1, shared / Math.min(8, userKeywords.size));
    const postShare = peerTopicPosts > 0 ? Math.min(1, peerTopicPosts / 5) : 0;
    topicSimilarity = Math.max(bioShare, postShare);
    reasons.push(
      topicSimilarity >= 0.4
        ? "Talks about your topics."
        : topicSimilarity > 0
          ? "Some overlap with your topics."
          : "Little overlap with your topics so far.",
    );
  } else {
    reasons.push("Not enough text to compare topics yet.");
  }

  let activityPoints = 0;
  if (postsLast30 !== null) {
    activityPoints = postsLast30 >= 8 ? 20 : postsLast30 >= 2 ? 10 : 0;
    reasons.push(`${postsLast30} posts seen in the last 30 days.`);
  }
  if (peer.accountCreatedAt) {
    const years = (now.getTime() - peer.accountCreatedAt.getTime()) / (365 * DAY_MS);
    if (years < 1) reasons.push("Account less than a year old.");
  }

  const score = Math.round(sizePoints + (topicSimilarity ?? 0) * 50 + activityPoints);
  return { category, score, topicSimilarity, reasons };
}

// ---- Patterns inside one peer account ------------------------------------------------

export type PeerStat = {
  postedAt: Date;
  lengthBucket: string;
  hookType: string;
  topics: string[];
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  impressions: number | null;
};

type PeerMetric = "impressions" | "replies" | "engagement_rate";

function value(stat: PeerStat, metric: PeerMetric): number | null {
  if (metric === "impressions") return stat.impressions;
  if (metric === "replies") return stat.replies;
  if (stat.impressions === null || stat.impressions <= 0 || stat.likes === null || stat.replies === null || stat.reposts === null) return null;
  return (stat.likes + stat.replies + stat.reposts) / stat.impressions;
}

export type PeerFinding = {
  dimension: "length" | "hook" | "topic";
  group: string;
  metric: PeerMetric;
  direction: "higher" | "lower";
  groupMedian: number;
  restMedian: number;
  groupN: number;
  restN: number;
  first: Date;
  last: Date;
  /** Within this account only: sample size, span and outlier sensitivity */
  confidence: Confidence;
  outlierSensitive: boolean;
};

const nums = (values: (number | null)[]) => values.filter((v): v is number => v !== null);

/**
 * Groups of one peer's posts that differ from that same account's other
 * posts by 25%+ on a median (5+ posts on each side). Comparing an account
 * with itself avoids comparing audiences of different sizes. A finding that
 * disappears without the group's single best post is outlier-sensitive.
 */
export function peerFindings(stats: PeerStat[]): PeerFinding[] {
  if (stats.length < Math.max(PEER_MIN_POSTS, MIN_TOTAL)) return [];
  const times = stats.map((s) => s.postedAt.getTime());
  const first = new Date(Math.min(...times));
  const last = new Date(Math.max(...times));
  const spanDays = Math.floor((last.getTime() - first.getTime()) / DAY_MS) + 1;
  const keyed: { dimension: PeerFinding["dimension"]; groups: Map<string, PeerStat[]> }[] = [
    { dimension: "length", groups: groupBy(stats, (s) => [s.lengthBucket]) },
    { dimension: "hook", groups: groupBy(stats, (s) => [s.hookType]) },
    { dimension: "topic", groups: groupBy(stats, (s) => s.topics) },
  ];
  const findings: PeerFinding[] = [];
  for (const { dimension, groups } of keyed) {
    for (const metric of ["replies", "engagement_rate", "impressions"] as PeerMetric[]) {
      let best: PeerFinding | null = null;
      for (const [group, members] of groups) {
        const rest = stats.filter((s) => !members.includes(s));
        const a = nums(members.map((s) => value(s, metric)));
        const b = nums(rest.map((s) => value(s, metric)));
        if (a.length < MIN_GROUP || b.length < MIN_REST) continue;
        const groupMedian = median(a)!;
        const restMedian = median(b)!;
        if (restMedian <= 0) continue;
        const lift = (groupMedian - restMedian) / restMedian;
        if (Math.abs(lift) < MIN_LIFT) continue;
        // Without the group's single most extreme post, does the difference hold?
        const trimmed = [...a].sort((x, y) => (lift > 0 ? y - x : x - y)).slice(1);
        const trimmedLift = (median(trimmed)! - restMedian) / restMedian;
        const outlierSensitive = Math.abs(trimmedLift) < MIN_LIFT || Math.sign(trimmedLift) !== Math.sign(lift);
        const smaller = Math.min(a.length, b.length);
        let confidence: Confidence = smaller >= 15 ? "good" : smaller >= 8 ? "moderate" : "limited";
        if (spanDays < MIN_SPAN_DAYS) confidence = confidence === "good" ? "moderate" : "limited";
        if (outlierSensitive) confidence = "limited";
        const finding: PeerFinding = {
          dimension,
          group,
          metric,
          direction: lift > 0 ? "higher" : "lower",
          groupMedian,
          restMedian,
          groupN: a.length,
          restN: b.length,
          first,
          last,
          confidence,
          outlierSensitive,
        };
        if (!best || Math.abs(lift) > Math.abs((best.groupMedian - best.restMedian) / best.restMedian)) best = finding;
      }
      if (best) findings.push(best);
    }
  }
  return findings;
}

function groupBy(stats: PeerStat[], keysOf: (s: PeerStat) => string[]): Map<string, PeerStat[]> {
  const groups = new Map<string, PeerStat[]>();
  for (const stat of stats) for (const key of keysOf(stat)) groups.set(key, [...(groups.get(key) ?? []), stat]);
  return groups;
}

const GROUP_LABEL: Record<string, string> = {
  short: "short (up to 100 characters)",
  standard: "standard-length (101–280 characters)",
  long: "long (over 280 characters)",
  question: "question-opening",
  number: "number-led",
  how_why: "how/why/what-led",
  statement: "statement-opening",
};

const groupLabel = (f: Pick<PeerFinding, "dimension" | "group">) =>
  f.dimension === "topic" ? `posts about "${f.group}"` : `${GROUP_LABEL[f.group] ?? f.group} posts`;

const showValue = (metric: PeerMetric, v: number) => (metric === "engagement_rate" ? `${(v * 100).toFixed(2)}%` : v >= 100 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 10) / 10));

/**
 * Peer findings as evidence: one item per pattern (dimension, group, metric,
 * direction) and per category, saying how many independent accounts show
 * it. Direct and aspirational peers are never mixed. Peer evidence never
 * supports "do less", and is at most "moderate" (2+ direct peers agreeing).
 */
export function peerEvidence(
  peers: { handle: string; category: PeerCategory; findings: PeerFinding[]; postsAnalyzed: number }[],
): Omit<EvidenceItem, "id">[] {
  const items: (Omit<EvidenceItem, "id"> & { strength: number })[] = [];
  for (const category of ["direct", "aspirational", "unknown"] as PeerCategory[]) {
    const group = peers.filter((p) => p.category === category);
    const withData = group.filter((p) => p.postsAnalyzed >= PEER_MIN_POSTS);
    const patterns = new Map<string, { handle: string; finding: PeerFinding }[]>();
    for (const peer of withData) {
      for (const finding of peer.findings) {
        const key = `${finding.dimension}|${finding.group}|${finding.metric}|${finding.direction}`;
        patterns.set(key, [...(patterns.get(key) ?? []), { handle: peer.handle, finding }]);
      }
    }
    for (const support of patterns.values()) {
      const f = support[0].finding;
      const label = groupLabel(f);
      const accounts = support.length;
      const confident = support.filter((s) => s.finding.confidence !== "limited").length;
      // Accounts in the same group whose posts point the other way on the same
      // metric: a different group did better, or this group did worse
      const backers = new Set(support.map((s) => s.handle));
      const opposite = withData.flatMap((peer) =>
        backers.has(peer.handle)
          ? []
          : peer.findings
              .filter(
                (g) =>
                  g.dimension === f.dimension &&
                  g.metric === f.metric &&
                  (g.group === f.group ? g.direction !== f.direction : g.direction === f.direction),
              )
              .slice(0, 1)
              .map((g) => ({ handle: peer.handle, finding: g })),
      );
      const confidence: Confidence = category === "direct" && accounts >= 2 && confident >= 2 && opposite.length === 0 ? "moderate" : "limited";
      const detail = support
        .map(
          (s) =>
            `@${s.handle}: median ${showValue(s.finding.metric, s.finding.groupMedian)} vs ${showValue(s.finding.metric, s.finding.restMedian)} (${s.finding.groupN} vs ${s.finding.restN} posts, ${day(s.finding.first)}–${day(s.finding.last)})${s.finding.outlierSensitive ? ", depends on one post" : ""}`,
        )
        .join("; ");
      const who = category === "direct" ? "direct peers" : category === "aspirational" ? "aspirational accounts (much larger, not a benchmark)" : "peers of unknown comparability";
      items.push({
        kind: "peer",
        evidenceType: "peer_observation",
        text: `Peer observation, ${who}: ${label} got ${f.direction} ${METRIC_NAME[f.metric]} than the same account's other posts at ${accounts} of ${withData.length} ${withData.length === 1 ? "account" : "accounts"} with enough data. ${detail}.${
          opposite.length
            ? ` Not consistent: ${opposite.map((o) => `at @${o.handle}, ${groupLabel(o.finding)} got ${o.finding.direction} ${METRIC_NAME[o.finding.metric]}`).join("; ")}.`
            : ""
        } Each account is compared only with itself; this suggests an idea to test, not a result for you.`,
        source: "growth",
        sampleSize: support.reduce((sum, s) => sum + s.finding.groupN + s.finding.restN, 0),
        confidence,
        supportsReduction: false,
        metric: f.metric,
        // The accounts behind the pattern; those pointing the other way are named in the text
        peerHandles: support.map((s) => s.handle),
        strength: accounts * 10 + confident,
      });
    }
  }
  return items
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 4)
    .map((item) => {
      const { strength, ...rest } = item;
      void strength;
      return rest;
    });
}

// ---- Stage --------------------------------------------------------------------------

/**
 * From the user's own evidence: starting without enough posts with
 * impressions; learning while the posts cover under 21 days or no own
 * pattern has more than limited confidence; evidence-based otherwise.
 */
export function strategyStage(input: {
  postsWithImpressions90: number;
  span90Days: number | null;
  ownPatternConfidences: Confidence[];
}): StrategyStage {
  if (input.postsWithImpressions90 < MIN_TOTAL) return "starting";
  if (input.span90Days === null || input.span90Days < MIN_SPAN_DAYS) return "learning";
  if (!input.ownPatternConfidences.some((c) => c !== "limited")) return "learning";
  return "evidence";
}

// ---- Four-week roadmap -----------------------------------------------------------------

const GOAL_PHRASE: Record<StrategyObjective, string> = {
  find_customers: "people who have the problem you solve",
  generate_leads: "people likely to need what you offer",
  build_authority: "people who care about your expertise",
  grow_audience: "people interested in your topics",
  meaningful_engagement: "people worth talking with",
};

/** Scout's own roadmap: used when the AI's doesn't pass validation */
export function templateRoadmap(stage: StrategyStage, objective: StrategyObjective): RoadmapWeek[] {
  const who = GOAL_PHRASE[objective];
  const weeks: Omit<RoadmapWeek, "week" | "source">[] =
    stage === "evidence"
      ? [
          { objective: "Do more of what your data supports", activities: ["Follow this week's plan", "Write posts in the formats and topics that did better for you"], milestone: "Plan done; posts published", modules: ["studio", "calendar"], measure: ["Impressions and replies per post"] },
          { objective: "Test one new idea", activities: ["Run one experiment, e.g. from a peer observation", "Keep joining conversations"], milestone: "Experiment under way", modules: ["studio", "opportunities"], measure: ["The experiment's metric"] },
          { objective: "Widen reach in your niche", activities: ["Explore a rising trend", "Reply where your audience talks"], milestone: "New conversations started", modules: ["trends", "opportunities"], measure: ["Replies and profile clicks, when X is connected"] },
          { objective: "Review and update the strategy", activities: ["Refresh Growth", "Compare with last month", "Update the plan"], milestone: "Updated strategy", modules: ["growth"], measure: ["Changes since the last plan"] },
        ]
      : [
          { objective: "Set a baseline", activities: ["Publish 2-3 posts: who you are and the problem you work on", `Find accounts and conversations of ${who}`], milestone: "First posts live; a few accounts to follow and learn from", modules: ["studio", "opportunities", "discovery"], measure: ["Impressions and replies of each post (refresh Growth)"] },
          { objective: "Test two content types", activities: ["Alternate two kinds of posts (e.g. a lesson vs a build update)", "Reply to a few relevant conversations"], milestone: "A few posts of each type", modules: ["studio", "calendar", "opportunities"], measure: ["Replies and impressions per type"] },
          { objective: "Refine topics", activities: ["Write more on topics that got replies", "Look at rising trends in your niche"], milestone: "Two or three topics you want to keep", modules: ["trends", "studio"], measure: ["Which topics got replies"] },
          { objective: "Review what you learned", activities: ["Refresh Growth", "Update the strategy with your own results"], milestone: "Your first evidence-based plan (once enough posts have numbers)", modules: ["growth"], measure: ["Posts with impressions; first patterns"] },
        ];
  return weeks.map((week, index) => ({ ...week, week: index + 1, source: "template" as const }));
}

const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The AI's roadmap if it's usable: 4 weeks, known modules, something to
 * measure each week, and no promised follower numbers or growth rates.
 * Otherwise Scout's template.
 */
export function validateRoadmap(
  raw: { week: number; objective: string; activities: string[]; milestone: string; modules: string[]; measure: string[] }[] | undefined,
  stage: StrategyStage,
  objective: StrategyObjective,
): RoadmapWeek[] {
  const promise = /\d[\d,.]*\s*%?\s*(new\s+)?(followers?|subscribers?)|\d+\s*%\s*(growth|more)|guarantee/i;
  if (!raw || raw.length !== 4) return templateRoadmap(stage, objective);
  const weeks = raw.map((w, index) => ({
    week: index + 1,
    objective: clip(w.objective, 140),
    activities: w.activities.map((a) => clip(a, 200)).filter(Boolean).slice(0, 4),
    milestone: clip(w.milestone, 200),
    modules: [...new Set(w.modules.filter((m): m is StrategyModule => (STRATEGY_MODULES as readonly string[]).includes(m)))],
    measure: w.measure.map((m) => clip(m, 160)).filter(Boolean).slice(0, 3),
    source: "ai" as const,
  }));
  const ok = weeks.every(
    (w) =>
      w.objective &&
      w.milestone &&
      w.activities.length > 0 &&
      w.measure.length > 0 &&
      ![w.objective, w.milestone, ...w.activities, ...w.measure].some((text) => promise.test(text)),
  );
  return ok ? weeks : templateRoadmap(stage, objective);
}
