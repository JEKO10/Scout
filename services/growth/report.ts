import "server-only";

import {
  getAccountSnapshots,
  getGrowthAccount,
  getGrowthPosts,
  getOldestPostAt,
  getPublishedDrafts,
  getReplyActivityCounts,
  lastGrowthRefreshAt,
} from "@/db/queries/growth";
import type { Post, Profile } from "@/db/schema";
import {
  dailySeries,
  findPatterns,
  followerSeries,
  followerWeeks,
  type GrowthPost,
  overview,
  postingTimes,
  recommendations,
  replyPerformance,
  type Snapshot,
  topicTable,
} from "@/lib/growth/analyze";
import type { GrowthRange } from "@/lib/growth/metrics";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

const DAY = 86_400_000;

const statusId = (url: string | null) => (url ? (/\/status\/(\d+)/.exec(url)?.[1] ?? null) : null);

/** Topic names to look for in post text: the Brain's, else the onboarding list */
function topicNames(profile: Profile): string[] {
  const brain = resolveScoutBrain(profile);
  const names = brain?.interests.topics.map((topic) => topic.label) ?? (profile.topics ?? "").split(/[,\n]/);
  return names.map((name) => name.trim()).filter((name) => name.length >= 3);
}

/** The Brain's own topic labels for the posts it analyzed (no new AI call) */
function brainTopicByPost(profile: Profile): Map<string, string> {
  const map = new Map<string, string>();
  const raw = profile.interestBrain as { data?: { topics?: { name: string; examplePostIds?: string[] }[] } } | null;
  for (const topic of raw?.data?.topics ?? []) for (const id of topic.examplePostIds ?? []) if (!map.has(id)) map.set(id, topic.name);
  return map;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Everything Growth Intelligence shows, from stored data only: no X or AI
 * call happens here.
 */
export async function buildGrowthReport(profile: Profile, { range, tz, now = new Date() }: { range: GrowthRange; tz: string; now?: Date }) {
  const start = new Date(now.getTime() - range * DAY);
  const previousStart = new Date(start.getTime() - range * DAY);
  const account = await getGrowthAccount(profile.id, profile.xHandle);
  const [lastRefresh, replyActivity, drafts] = await Promise.all([
    lastGrowthRefreshAt(profile.id),
    getReplyActivityCounts(profile.id, start),
    getPublishedDrafts(profile.id),
  ]);
  if (!account) {
    return { account: null, range, start, now, lastRefresh, replyActivity, confirmedWithoutMetrics: drafts.length } as const;
  }

  const [rows, oldest, snapshotRows] = await Promise.all([
    getGrowthPosts(account.id, previousStart),
    getOldestPostAt(account.id),
    getAccountSnapshots(account.id, new Date(previousStart.getTime() - 14 * DAY)),
  ]);

  const draftByPostId = new Map(drafts.flatMap((draft) => (statusId(draft.publishedUrl) ? [[statusId(draft.publishedUrl)!, draft] as const] : [])));
  const brainTopics = brainTopicByPost(profile);
  const names = topicNames(profile).map((name) => ({ name, pattern: new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}($|[^\\p{L}\\p{N}])`, "iu") }));

  const toGrowthPost = (post: Post): GrowthPost => {
    const draft = draftByPostId.get(post.platformPostId);
    const studioTopic = draft ? (draft.topic ?? draft.trendLabel) : null;
    const brainTopic = brainTopics.get(post.platformPostId) ?? null;
    const keyword = !studioTopic && !brainTopic ? (names.find((item) => item.pattern.test(post.content))?.name ?? null) : null;
    const m = post.metrics ?? {};
    return {
      id: post.id,
      platformPostId: post.platformPostId,
      url: post.url,
      text: post.content,
      publishedAt: post.publishedAt,
      kind: post.kind ?? null,
      replyToPostId: post.replyToPostId,
      // null: not reported (never treated as zero)
      likes: m.likes ?? null,
      replies: m.replies ?? null,
      reposts: m.reposts ?? null,
      bookmarks: m.bookmarks ?? null,
      impressions: m.impressions ?? null,
      source: post.metricsSource ?? null,
      fetchedAt: post.metricsFetchedAt,
      draft: draft ? { id: draft.id, title: draft.title, goal: draft.goal, format: draft.format, fromTrend: Boolean(draft.sourceTrendId) } : null,
      topic: studioTopic ?? brainTopic ?? keyword,
      topicSource: studioTopic ? "studio" : brainTopic ? "brain" : keyword ? "keyword" : null,
    };
  };

  const all = rows.map(toGrowthPost);
  const current = all.filter((post) => post.publishedAt >= start);
  const previous = all.filter((post) => post.publishedAt < start);
  const snapshots: Snapshot[] = snapshotRows.map((row) => ({ day: row.day, followers: row.followers }));
  // Scout holds everything since its oldest stored post (syncs read newest first)
  const complete = Boolean(oldest && oldest <= start);
  const previousComplete = Boolean(oldest && oldest <= previousStart);
  const linked = new Set(current.filter((post) => post.draft).map((post) => post.draft!.id));

  return {
    account,
    range,
    start,
    now,
    lastRefresh,
    replyActivity,
    oldest,
    posts: current,
    overview: overview(current, previous, { complete, previousComplete, snapshots, start, previousStart, now }),
    daily: dailySeries(current, tz),
    followers: followerSeries(snapshots.filter((snap) => snap.day >= start.toISOString().slice(0, 10))),
    findings: findPatterns(current, { tz, periodDays: range }),
    topics: topicTable(current, start, now),
    times: postingTimes(current, tz),
    followerWeeks: followerWeeks(snapshots, all, now),
    replies: replyPerformance(current, replyActivity.repliedToPostIds),
    /** Studio drafts the user marked posted that Scout can't match to an X post with metrics */
    confirmedWithoutMetrics: drafts.filter((draft) => !linked.has(draft.id) && !(statusId(draft.publishedUrl) && all.some((post) => post.platformPostId === statusId(draft.publishedUrl)))).length,
  } as const;
}

export function growthRecommendations(report: Awaited<ReturnType<typeof buildGrowthReport>>) {
  return "findings" in report && report.findings ? recommendations(report.findings) : [];
}
