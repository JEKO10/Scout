import "server-only";

import { getOpenOpportunityPostIds, getScanCoverage, getTrendCandidates, replaceTrends } from "@/db/queries/trends";
import { buildTrends, OBSERVATION_DAYS, WINDOW_HOURS } from "@/lib/trends/detect";

/**
 * Day 29: recomputes a user's trends from the posts their scans already
 * collected and scored. Runs after each scan (not on page loads); no X or AI
 * calls, so it costs only a database read and write.
 */
export async function computeTrends(profileId: string, now = new Date()): Promise<{ trends: number }> {
  const hour = 3_600_000;
  const [candidates, coverage] = await Promise.all([
    getTrendCandidates(profileId, new Date(now.getTime() - OBSERVATION_DAYS * 24 * hour)),
    getScanCoverage(profileId, {
      currentStart: new Date(now.getTime() - WINDOW_HOURS * hour),
      previousStart: new Date(now.getTime() - 2 * WINDOW_HOURS * hour),
    }),
  ]);
  const open = await getOpenOpportunityPostIds(
    profileId,
    candidates.map((candidate) => candidate.platformPostId),
  );
  const drafts = buildTrends(
    candidates.map((candidate) => ({
      shouldEngage: candidate.shouldEngage,
      openOpportunity: open.has(candidate.platformPostId),
      id: candidate.id,
      label: candidate.topic,
      content: candidate.content,
      authorKey: candidate.authorPlatformUserId ?? candidate.authorHandle.toLowerCase(),
      postedAt: candidate.postedAt,
      score: candidate.score ?? 0,
      metrics: candidate.metrics,
      discoveryTopicId: candidate.discoveryTopicId,
      reason: candidate.reason,
    })),
    coverage,
    now,
  );
  await replaceTrends(
    profileId,
    drafts.map((draft) => ({
      key: draft.key,
      label: draft.label,
      terms: draft.terms,
      summary: draft.summary,
      why: draft.why,
      discoveryTopicId: draft.discoveryTopicId,
      status: draft.status,
      confidence: draft.confidence,
      score: draft.score,
      relevance: draft.relevance,
      scoreBreakdown: draft.scoreBreakdown,
      momentum: draft.momentum,
      dailyCounts: draft.dailyCounts,
      postCount: draft.postCount,
      authorCount: draft.authorCount,
      engagement: draft.engagement,
      representativeCandidateIds: draft.representativeIds,
      firstPostAt: draft.firstPostAt,
      lastPostAt: draft.lastPostAt,
      opportunityScore: draft.opportunityScore,
      opportunityBreakdown: draft.opportunityBreakdown,
      timing: draft.timing,
    })),
  );
  return { trends: drafts.length };
}
