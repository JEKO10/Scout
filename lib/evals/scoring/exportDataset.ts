import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import db from "@/db";
import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import {
  opportunitiesTable,
  profilesTable,
  scoutCandidatesTable,
} from "@/db/schema";
import { surfaceThreshold } from "@/lib/scout/sensitivity";
import { toJudgmentInput } from "@/services/opportunities/rankCandidates";
import { freshnessPoints } from "@/services/opportunities/score";
import { brainForRanking } from "@/services/opportunities/scoreOpportunity";
import { hasTextBeyondLinks } from "@/services/scout-brain/prompt";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

import type { EvalDataset, EvalExample } from "./types";

// Builds the evaluation dataset from candidates Scout already scored: SELECTs
// only, no X or OpenAI call, nothing written to the database. The result
// holds Scout Brains, so it goes to a git-ignored local file.

/** Deterministic shuffle, so the same database gives the same dataset */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function exportScoringDataset({
  perProfile = 80,
  seed = 20,
}: { perProfile?: number; seed?: number } = {}): Promise<EvalDataset> {
  const scoredProfiles = await db
    .selectDistinct({ profileId: scoutCandidatesTable.profileId })
    .from(scoutCandidatesTable)
    .where(isNotNull(scoutCandidatesTable.scoredAt));

  const dataset: EvalDataset = {
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: {},
    examples: [],
  };

  let index = 0;
  for (const { profileId } of scoredProfiles) {
    const [profile] = await db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.id, profileId));
    const brain = profile ? resolveScoutBrain(profile) : null;
    if (!profile || !brain) continue;
    const profileKey = `profile-${++index}`;

    // The same context rankCandidates builds
    const holdout = new Set(brain.holdoutPostIds);
    const history = (await getRecentPostsForProfile(profileId, 100)).filter(
      (post) =>
        !holdout.has(post.platformPostId) && hasTextBeyondLinks(post.content),
    );
    const voiceSamples =
      history.length === 0 ? await getVoiceSamples(profileId) : [];
    const threshold = surfaceThreshold(profile.opportunitySensitivity);
    dataset.profiles[profileKey] = {
      brain: brainForRanking(brain),
      userWriting: history.length
        ? history.map((post) => post.content)
        : voiceSamples.map((sample) => sample.userReply),
      threshold,
    };

    const candidates = await db
      .select()
      .from(scoutCandidatesTable)
      .where(
        and(
          eq(scoutCandidatesTable.profileId, profileId),
          isNotNull(scoutCandidatesTable.scoredAt),
        ),
      );
    const opportunities = await db
      .select({
        platformPostId: opportunitiesTable.platformPostId,
        status: opportunitiesTable.status,
      })
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.profileId, profileId),
          inArray(
            opportunitiesTable.platformPostId,
            candidates.map((candidate) => candidate.platformPostId),
          ),
        ),
      );
    const statusOf = new Map(
      opportunities.map((row) => [row.platformPostId, row.status]),
    );

    // Stratified: every high, labeled, acted-on and quote post, then medium
    // and low ones up to the per-profile size
    const strataOf = (candidate: (typeof candidates)[number]) => {
      const score = candidate.score ?? 0;
      const strata = [
        score >= threshold ? "high" : score >= 30 ? "medium" : "low",
      ];
      if (candidate.kind === "quote") strata.push("quote");
      if (candidate.userLabel) strata.push("labeled");
      const status = statusOf.get(candidate.platformPostId);
      if (status === "replied" || status === "saved") strata.push(status);
      return strata;
    };
    const must = candidates.filter((candidate) =>
      strataOf(candidate).some((s) => s !== "medium" && s !== "low"),
    );
    const rest = seededShuffle(
      candidates.filter((candidate) => !must.includes(candidate)),
      seed + index,
    );
    // Quotes are numerous; keep at most a third of the slots for them
    const quotesOnly = must.filter(
      (c) =>
        strataOf(c).join() === "low,quote" ||
        strataOf(c).join() === "medium,quote",
    );
    const capQuotes = Math.floor(perProfile / 3);
    const chosen = [
      ...must.filter((c) => !quotesOnly.includes(c)),
      ...seededShuffle(quotesOnly, seed).slice(0, capQuotes),
    ];
    for (const candidate of rest) {
      if (chosen.length >= perProfile) break;
      chosen.push(candidate);
    }

    for (const candidate of chosen) {
      const scoredAt = candidate.scoredAt ?? new Date();
      const example: EvalExample = {
        id: candidate.id,
        profileKey,
        input: toJudgmentInput(candidate, history, voiceSamples, scoredAt),
        freshness: freshnessPoints(candidate.postedAt, scoredAt),
        postedAt: candidate.postedAt.toISOString(),
        url: candidate.url,
        strata: strataOf(candidate),
        original: {
          score: candidate.score,
          breakdown: candidate.scoreBreakdown,
          shouldEngage: candidate.shouldEngage,
          reason: candidate.reason,
          suggestedAngle: candidate.suggestedAngle,
          topic: candidate.topic,
          surfaced: statusOf.has(candidate.platformPostId),
          opportunityStatus: statusOf.get(candidate.platformPostId) ?? null,
          userLabel: candidate.userLabel,
        },
      };
      dataset.examples.push(example);
    }
  }
  return dataset;
}
