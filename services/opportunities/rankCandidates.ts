import "server-only";

import { saveOpportunities } from "@/db/queries/opportunities";
import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getProfileById } from "@/db/queries/profiles";
import {
  countUnscoredCandidates,
  getUnscoredCandidates,
  saveCandidateScore,
} from "@/db/queries/scoutCandidates";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import type { ScoutCandidate, VoiceSample } from "@/db/schema";
import type { ScoringStats } from "@/lib/scout/types";
import { learningAdjustment } from "@/services/learning/rankingAdjustment";
import { refreshLearning } from "@/services/learning/refreshLearning";
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
/** Accepted replies this recent count as "already made this point" */
const RECENT_ARGUMENT_DAYS = 14;

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
  // Cold start (Day 14): no posts yet, so the user's own onboarding replies
  // stand in as their writing history
  const voiceSamples = history.length === 0 ? await getVoiceSamples(profileId) : [];
  const brainJson = formatBrainForRanking(brain);
  const now = new Date();

  // Day 13: learned behavior nudges the base score (re-learned every ~10
  // new interactions, not on every run)
  const { memory, learning } = await refreshLearning(profileId);
  const learningContext = {
    overEngagedHandles: new Set(
      memory.people
        .filter((person) => person.relationship === "over_engaged")
        .map((person) => person.handle.toLowerCase()),
    ),
    recentArguments: memory.arguments
      .filter((argument) => now.getTime() - argument.at.getTime() < RECENT_ARGUMENT_DAYS * 86_400_000)
      .map((argument) => argument.text),
  };

  const batches: ScoutCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  const settled = await mapSettled(batches, CONCURRENCY, async (batch) => {
    const judgments = await judgeCandidates(
      brainJson,
      batch.map((candidate) => toJudgmentInput(candidate, history, voiceSamples, now)),
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

      const topic = judgment.topic.trim() || null;
      const adjustment = learningAdjustment(
        { topic, authorHandle: candidate.authorHandle, suggestedAngle: judgment.suggestedAngle },
        learning,
        learningContext,
      );
      const breakdown = {
        ...scoreBreakdown(judgment, freshnessPoints(candidate.postedAt, now)),
        learning: adjustment.points,
        learningNotes: adjustment.notes,
      };
      const score = totalScore(breakdown);
      await saveCandidateScore(profileId, candidate.id, {
        score,
        scoreBreakdown: breakdown,
        shouldEngage: judgment.shouldEngage,
        reason: judgment.reason,
        suggestedAngle: judgment.suggestedAngle || null,
        topic,
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
          topic,
          status: "new" as const,
          postedAt: candidate.postedAt,
        });
      }
    }
  }

  const surfaced = await saveOpportunities(scoutRunId, profileId, opportunities);
  // Everything still waiting, including candidates beyond this run's cap
  const unscored = await countUnscoredCandidates(profileId);
  return { scored, unscored, surfaced };
}

function toJudgmentInput(
  candidate: ScoutCandidate,
  history: Parameters<typeof pickRelevantPosts>[0],
  voiceSamples: VoiceSample[],
  now: Date,
): CandidateForJudgment {
  const relatedWriting = history.length
    ? pickRelevantPosts(history, candidate.content, HISTORY_PER_CANDIDATE).map((post) => post.content)
    : voiceSamples
        .slice(0, HISTORY_PER_CANDIDATE)
        .map((sample) => `(onboarding reply) ${sample.userReply}`);

  return {
    candidateId: candidate.id,
    authorHandle: candidate.authorHandle,
    kind: candidate.kind,
    hoursAgo: Math.round((now.getTime() - candidate.postedAt.getTime()) / 3_600_000),
    replies: candidate.metrics?.replies ?? null,
    content: candidate.content,
    history: relatedWriting.map((text) => text.slice(0, HISTORY_MAX_CHARS)),
  };
}
