import "server-only";

import { saveOpportunities } from "@/db/queries/opportunities";
import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getProfileById } from "@/db/queries/profiles";
import {
  countUnscoredCandidates,
  getUnscoredCandidates,
  rejectCandidates,
  saveCandidateScore,
} from "@/db/queries/scoutCandidates";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import type { ScoutCandidate, VoiceSample } from "@/db/schema";
import { splitQuotedPost } from "@/lib/posts/quotedPost";
import { surfaceThreshold } from "@/lib/scout/sensitivity";
import type { ScoringStats } from "@/lib/scout/types";
import { learningAdjustment } from "@/services/learning/rankingAdjustment";
import { refreshLearning } from "@/services/learning/refreshLearning";
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
  brainForRanking,
  type CandidateForJudgment,
  judgeCandidates,
} from "./scoreOpportunity";
import { getScoringStrategy, scoreWithStrategy } from "./scoringStrategy";

/** Upper bound per run without a plan limit; the rest wait for the next run */
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
  {
    maxCandidates = MAX_CANDIDATES_PER_RUN,
  }: {
    /** From the plan and the remaining scoring budget; 0 scores nothing */
    maxCandidates?: number;
  } = {},
): Promise<ScoringStats> {
  if (maxCandidates <= 0) {
    return {
      scored: 0,
      unscored: await countUnscoredCandidates(profileId),
      surfaced: 0,
      skippedReason:
        "Your monthly AI scoring budget is used up; these candidates are scored when it resets.",
    };
  }
  const [profile, candidates] = await Promise.all([
    getProfileById(profileId),
    getUnscoredCandidates(profileId, maxCandidates),
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
  const rankingBrain = brainForRanking(brain);
  const now = new Date();
  // Fewer / Balanced / More, from the user's settings
  const threshold = surfaceThreshold(profile?.opportunitySensitivity);

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

  // Day 20: baseline (the Day 9 pipeline) unless SCOUT_SCORING_STRATEGY says otherwise
  const strategy = getScoringStrategy();
  const result = await scoreWithStrategy(
    strategy,
    candidates.map((candidate) => toJudgmentInput(candidate, history, voiceSamples, now)),
    {
      judge: (stage, batch) =>
        judgeCandidates(rankingBrain, batch, { profileId, scoutRunId, operation: "opportunity_scoring" }, stage),
      freshness: new Map(candidates.map((candidate) => [candidate.id, freshnessPoints(candidate.postedAt, now)])),
      threshold,
      userWriting: history.length
        ? history.map((post) => post.content)
        : voiceSamples.map((sample) => sample.userReply),
    },
  );
  for (const error of result.errors) console.error("Opportunity scoring batch failed", error);

  // Pre-filtered (never with baseline): rejected like filtered posts, never
  // charged, scored or delivered again
  const byReason = Map.groupBy(result.prefiltered, (item) => item.reason);
  for (const [reason, items] of byReason) {
    await rejectCandidates(profileId, items.map((item) => item.id), reason);
  }

  let scored = 0;
  const opportunities = [];
  for (const candidate of candidates) {
    const judgment = result.judgments.get(candidate.id);
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

    if (shouldSurface(score, judgment.shouldEngage, threshold)) {
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

  const surfaced = await saveOpportunities(scoutRunId, profileId, opportunities);
  // Everything still waiting, including candidates beyond this run's cap
  const unscored = await countUnscoredCandidates(profileId);
  return {
    scored,
    unscored,
    surfaced,
    strategy: strategy.id,
    models: result.models,
    reasoningEfforts: result.reasoningEfforts,
    promptVersions: [
      ...new Set([strategy.primary.prompt, ...(strategy.escalation ? [strategy.escalation.stage.prompt] : [])]),
    ],
    calls: result.calls,
    failedCalls: result.failedCalls,
    escalated: result.escalated,
    prefiltered: result.prefiltered.length,
    latencyMs: result.latencyMs,
  };
}

/** The author's words and, for a quote, the quoted post apart from them. */
function quoteParts(content: string): { content: string; quotedPost?: string } {
  const { own, quoted } = splitQuotedPost(content);
  return quoted ? { content: own, quotedPost: quoted } : { content: own };
}

/** Also used by the scoring evaluation (lib/evals/scoring) to rebuild the exact input. */
export function toJudgmentInput(
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
    ...quoteParts(candidate.content),
    history: relatedWriting.map((text) => text.slice(0, HISTORY_MAX_CHARS)),
  };
}
