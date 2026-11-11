import "server-only";

import { sql } from "drizzle-orm";

import db from "@/db";
import {
  opportunitiesTable,
  scanJobsTable,
  scoutCandidatesTable,
  xAccountsTable,
  xPostsTable,
} from "@/db/schema";

// Bounded deletes (at most `batch` rows each), so a cleanup never holds a
// scheduler tick for long; whatever is left goes on the next tick.

/**
 * Cached X posts older than `days`, unless an opportunity still points at
 * them or some user has them waiting to be scored. Older than the 7-day
 * delivery window, they can't be delivered to anyone again.
 */
export async function deleteExpiredCachedPosts(days: number, batch: number): Promise<number> {
  const result = await db.execute(sql`
    delete from ${xPostsTable} where "platformPostId" in (
      select x."platformPostId" from ${xPostsTable} x
      where x."postedAt" < now() - make_interval(days => ${days})
        and not exists (
          select 1 from ${opportunitiesTable} o where o."platformPostId" = x."platformPostId"
        )
        and not exists (
          select 1 from ${scoutCandidatesTable} c
          where c."platformPostId" = x."platformPostId"
            and c."scoredAt" is null and c."rejectedReason" is null
        )
      limit ${batch}
    )
  `);
  return result.rowCount ?? 0;
}

/**
 * Filtered-out deliveries older than `days`: past the delivery window and
 * gone from the cache, they can't come back, so the record isn't needed.
 * Never rows an opportunity uses (filtered posts never become one).
 */
export async function deleteOldRejectedCandidates(days: number, batch: number): Promise<number> {
  const result = await db.execute(sql`
    delete from ${scoutCandidatesTable} where "id" in (
      select c."id" from ${scoutCandidatesTable} c
      where c."rejectedReason" is not null
        and c."postedAt" < now() - make_interval(days => ${days})
        and not exists (
          select 1 from ${opportunitiesTable} o
          where o."profileId" = c."profileId" and o."platformPostId" = c."platformPostId"
        )
      limit ${batch}
    )
  `);
  return result.rowCount ?? 0;
}

/** Finished scheduler jobs older than `days`. Open jobs are never touched. */
export async function deleteOldJobs(days: number, batch: number): Promise<number> {
  const result = await db.execute(sql`
    delete from ${scanJobsTable} where "id" in (
      select "id" from ${scanJobsTable}
      where "status" in ('completed', 'failed', 'skipped')
        and "createdAt" < now() - make_interval(days => ${days})
      limit ${batch}
    )
  `);
  return result.rowCount ?? 0;
}

/** Clears X fetch locks that expired (their holder died); they're ignored anyway. */
export async function clearExpiredFetchLocks(): Promise<number> {
  const result = await db.execute(sql`
    update ${xAccountsTable}
    set "fetchLockToken" = null, "fetchLockedUntil" = null
    where "fetchLockedUntil" < now()
  `);
  return result.rowCount ?? 0;
}
