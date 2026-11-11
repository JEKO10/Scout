import "server-only";

import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";

import db from "@/db";
import { type ScoutCandidate, scoutCandidatesTable } from "@/db/schema";
import type { NormalizedCandidatePost } from "@/lib/posts/types";
import type { CandidateFilterReason } from "@/lib/scout/types";

/** Which of these posts earlier scans already turned into candidates. */
export async function getSeenPlatformPostIds(
  profileId: string,
  platformPostIds: string[],
): Promise<Set<string>> {
  if (platformPostIds.length === 0) return new Set();

  const rows = await db
    .select({ id: scoutCandidatesTable.platformPostId })
    .from(scoutCandidatesTable)
    .where(
      and(
        eq(scoutCandidatesTable.profileId, profileId),
        inArray(scoutCandidatesTable.platformPostId, platformPostIds),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

export type CandidateToSave = NormalizedCandidatePost & {
  watchlistAccountId: string;
  source: string;
};

/**
 * Returns how many were new. UNIQUE(profileId, platform, platformPostId) is
 * the last guard against processing a post twice, e.g. two overlapping runs.
 * With `rejectedReason` the posts are stored as delivered but turned down by
 * the filters: never scored, never delivered again.
 */
export async function saveCandidates(
  runId: string,
  profileId: string,
  candidates: (CandidateToSave & { rejectedReason?: CandidateFilterReason })[],
): Promise<number> {
  if (candidates.length === 0) return 0;

  const inserted = await db
    .insert(scoutCandidatesTable)
    .values(
      // Only the columns: normalized posts carry extra source details
      candidates.map((candidate) => ({
        runId,
        profileId,
        watchlistAccountId: candidate.watchlistAccountId,
        source: candidate.source,
        platform: candidate.platform,
        platformPostId: candidate.platformPostId,
        authorPlatformUserId: candidate.authorPlatformUserId,
        authorHandle: candidate.authorHandle,
        content: candidate.content,
        url: candidate.url,
        kind: candidate.kind,
        metrics: candidate.metrics ?? null,
        postedAt: candidate.postedAt,
        rejectedReason: candidate.rejectedReason ?? null,
      })),
    )
    .onConflictDoNothing({
      target: [
        scoutCandidatesTable.profileId,
        scoutCandidatesTable.platform,
        scoutCandidatesTable.platformPostId,
      ],
    })
    .returning({ id: scoutCandidatesTable.id });
  return inserted.length;
}

/** A profile's newest candidates across runs, for review and labeling. */
export async function getRecentCandidates(
  profileId: string,
  limit = 100,
): Promise<ScoutCandidate[]> {
  return db
    .select()
    .from(scoutCandidatesTable)
    .where(
      and(eq(scoutCandidatesTable.profileId, profileId), isNull(scoutCandidatesTable.rejectedReason)),
    )
    .orderBy(desc(scoutCandidatesTable.postedAt))
    .limit(limit);
}

/** The user's blind YES / MAYBE / NO; null clears it. */
export async function setCandidateLabel(
  profileId: string,
  candidateId: string,
  label: ScoutCandidate["userLabel"],
): Promise<boolean> {
  const updated = await db
    .update(scoutCandidatesTable)
    .set({ userLabel: label, labeledAt: label ? new Date() : null })
    .where(
      and(
        eq(scoutCandidatesTable.id, candidateId),
        eq(scoutCandidatesTable.profileId, profileId),
      ),
    )
    .returning({ id: scoutCandidatesTable.id });
  return updated.length > 0;
}

/** Candidates the Opportunity Engine hasn't judged yet, from any run. */
export async function getUnscoredCandidates(
  profileId: string,
  limit: number,
): Promise<ScoutCandidate[]> {
  return db
    .select()
    .from(scoutCandidatesTable)
    .where(
      and(
        eq(scoutCandidatesTable.profileId, profileId),
        isNull(scoutCandidatesTable.scoredAt),
        isNull(scoutCandidatesTable.rejectedReason),
      ),
    )
    .orderBy(desc(scoutCandidatesTable.postedAt))
    .limit(limit);
}

export async function saveCandidateScore(
  profileId: string,
  candidateId: string,
  score: Pick<
    ScoutCandidate,
    | "score"
    | "scoreBreakdown"
    | "shouldEngage"
    | "reason"
    | "suggestedAngle"
    | "topic"
  >,
): Promise<void> {
  await db
    .update(scoutCandidatesTable)
    .set({ ...score, scoredAt: new Date() })
    .where(
      and(
        eq(scoutCandidatesTable.id, candidateId),
        eq(scoutCandidatesTable.profileId, profileId),
      ),
    );
}

export async function countUnscoredCandidates(profileId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(scoutCandidatesTable)
    .where(
      and(
        eq(scoutCandidatesTable.profileId, profileId),
        isNull(scoutCandidatesTable.scoredAt),
        isNull(scoutCandidatesTable.rejectedReason),
      ),
    );
  return row.value;
}
