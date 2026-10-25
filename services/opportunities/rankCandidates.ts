import "server-only";

import { saveOpportunities } from "@/db/queries/opportunities";
import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getProfileById } from "@/db/queries/profiles";
import {
  getUnscoredCandidates,
  saveCandidateScore,
} from "@/db/queries/scoutCandidates";
import type { ScoutCandidate } from "@/db/schema";
import type { ScoringStats } from "@/lib/scout/types";
import { mapSettled } from "@/services/scout/concurrency";
import { hasTextBeyondLinks } from "@/services/scout-brain/prompt";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { pickRelevantPosts } from "@/services/scout-brain/retrieval";

import {
  freshnessPoints,
  scoreBreakdown,
  shouldSurface,
  totalScore,
} from "./score";
import {
  type CandidateForJudgment,
  formatBrainForRanking,
  judgeCandidates,
} from "./scoreOpportunity";

/** Candidates per OpenAI call */
const BATCH_SIZE = 10;
/** Parallel OpenAI calls */
const CONCURRENCY = 2;
/** Upper bound per run; the rest wait for the next run */
const MAX_CANDIDATES_PER_RUN = 60;
/** The user's own past posts sent with each candidate */
const HISTORY_PER_CANDIDATE = 3;
const HISTORY_MAX_CHARS = 280;

/**
 * Day 9 Opportunity Engine: judge every unscored candidate against the Scout
 * Brain, add deterministic freshness, keep the score on the candidate and
 * surface the ones above the threshold as opportunities.
 */
export async function rankCandidates(
  profileId: string,
  scoutRunId: string,
): Promise<ScoringStats> {
  const [profile, candidates] = await Promise.all([
    getProfileById(profileId),
    getUnscoredCandidates(profileId, MAX_CANDIDATES_PER_RUN),
  ]);
  const brain = profile ? resolveScoutBrain(profile) : null;
  if (!brain) {
    return {
      scored: 0,
      unscored: candidates.length,
      surfaced: 0,
      skippedReason: "Analyze your profile first; scoring needs a Scout Brain.",
    };
  }
  if (candidates.length === 0) return { scored: 0, unscored: 0, surfaced: 0 };

  // The user's own posts, minus the brain's eval holdout
  const holdout = new Set(brain.holdoutPostIds);
  const history = (await getRecentPostsForProfile(profileId, 100)).filter(
    (post) => !holdout.has(post.platformPostId) && hasTextBeyondLinks(post.content),
  );
  const brainJson = formatBrainForRanking(brain);
  const now = new Date();

  const batches: ScoutCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  const settled = await mapSettled(batches, CONCURRENCY, async (batch) => {
    const judgments = await judgeCandidates(
      brainJson,
      batch.map((candidate) => toJudgmentInput(candidate, history, now)),
    );
    return { batch, judgments };
  });

  let scored = 0;
  const opportunities = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("Opportunity scoring batch failed", result.reason);
      continue;
    }
    for (const candidate of result.value.batch) {
      const judgment = result.value.judgments.get(candidate.id);
      if (!judgment) continue; // left unscored; the next run retries it

      const breakdown = scoreBreakdown(judgment, freshnessPoints(candidate.postedAt, now));
      const score = totalScore(breakdown);
      await saveCandidateScore(profileId, candidate.id, {
        score,
        scoreBreakdown: breakdown,
        shouldEngage: judgment.shouldEngage,
        reason: judgment.reason,
        suggestedAngle: judgment.suggestedAngle || null,
      });
      scored++;

      if (shouldSurface(score, judgment.shouldEngage)) {
        opportunities.push({
          platform: candidate.platform,
          platformPostId: candidate.platformPostId,
          postUrl: candidate.url,
          authorPlatformUserId: candidate.authorPlatformUserId,
          authorHandle: candidate.authorHandle,
          content: candidate.content,
          score,
          scoreBreakdown: breakdown,
          reason: judgment.reason,
          suggestedAngle: judgment.suggestedAngle,
          status: "new" as const,
          postedAt: candidate.postedAt,
        });
      }
    }
  }

  const surfaced = await saveOpportunities(scoutRunId, profileId, opportunities);
  return { scored, unscored: candidates.length - scored, surfaced };
}

function toJudgmentInput(
  candidate: ScoutCandidate,
  history: Parameters<typeof pickRelevantPosts>[0],
  now: Date,
): CandidateForJudgment {
  return {
    candidateId: candidate.id,
    authorHandle: candidate.authorHandle,
    kind: candidate.kind,
    hoursAgo: Math.round((now.getTime() - candidate.postedAt.getTime()) / 3_600_000),
    replies: candidate.metrics?.replies ?? null,
    content: candidate.content,
    history: pickRelevantPosts(history, candidate.content, HISTORY_PER_CANDIDATE).map(
      (post) => post.content.slice(0, HISTORY_MAX_CHARS),
    ),
  };
}
