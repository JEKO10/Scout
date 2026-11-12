import "server-only";

import { and, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";

import db from "@/db";
import { opportunitiesTable, type ScoutCandidate, scoutCandidatesTable } from "@/db/schema";

const c = scoutCandidatesTable;

/**
 * Scored posts of this user that never became opportunities, from the last
 * `days`: unrated ones, plus those rated since `ratedSince` (they count
 * against today's limit). Reads only what scoring already stored.
 */
export async function getMissCandidates(profileId: string, { days, ratedSince }: { days: number; ratedSince: Date }) {
  return db
    .select({
      id: c.id,
      authorHandle: c.authorHandle,
      content: c.content,
      url: c.url,
      postedAt: c.postedAt,
      score: sql<number>`coalesce(${c.score}, 0)`,
      shouldEngage: sql<boolean>`coalesce(${c.shouldEngage}, false)`,
      missRatedAt: c.missRatedAt,
    })
    .from(c)
    .where(
      and(
        eq(c.profileId, profileId),
        isNotNull(c.scoredAt),
        isNull(c.rejectedReason),
        gte(c.postedAt, sql`now() - make_interval(days => ${days})`),
        or(isNull(c.missRatedAt), gte(c.missRatedAt, ratedSince)),
        sql`not exists (
          select 1 from ${opportunitiesTable} o
          where o."profileId" = ${c.profileId} and o."platform" = ${c.platform}
            and o."platformPostId" = ${c.platformPostId}
        )`,
      ),
    )
    .orderBy(desc(c.postedAt))
    .limit(500);
}

/** Stores the user's verdict; false when the post isn't theirs or wasn't a miss candidate. */
export async function rateMissedCandidate(
  profileId: string,
  candidateId: string,
  rating: NonNullable<ScoutCandidate["missRating"]>,
  sample: NonNullable<ScoutCandidate["missSample"]>,
): Promise<boolean> {
  const rows = await db
    .update(c)
    .set({ missRating: rating, missSample: sample, missRatedAt: sql`now()` })
    .where(and(eq(c.id, candidateId), eq(c.profileId, profileId), isNotNull(c.scoredAt)))
    .returning({ id: c.id });
  return rows.length > 0;
}
