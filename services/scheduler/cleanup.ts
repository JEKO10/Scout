import "server-only";

import {
  clearExpiredFetchLocks,
  deleteExpiredCachedPosts,
  deleteOldJobs,
  deleteOldRejectedCandidates,
} from "@/db/queries/cleanup";

/**
 * Retention policy (Day 18):
 * - Shared X post cache: 14 days after the post was published, twice the
 *   7-day delivery window. Kept longer while an opportunity references the
 *   post or any user still has it waiting to be scored.
 * - Rejected deliveries (replies, reposts… a filter turned down): 14 days.
 *   They only exist so a post isn't delivered twice, which can't happen once
 *   it's past the delivery window and out of the cache.
 * - Scheduler jobs: 30 days after creation, once finished. Open jobs stay.
 * - Expired X fetch locks: cleared on every pass.
 * Scored candidates, opportunities, replies and runs are user data: never
 * deleted by cleanup.
 */
export const RETENTION = {
  cachedPostDays: 14,
  rejectedCandidateDays: 14,
  finishedJobDays: 30,
  /** Rows per table per pass */
  batch: 1_000,
};

export async function runCleanup() {
  const [cachedPosts, rejectedCandidates, jobs, locks] = await Promise.all([
    deleteExpiredCachedPosts(RETENTION.cachedPostDays, RETENTION.batch),
    deleteOldRejectedCandidates(RETENTION.rejectedCandidateDays, RETENTION.batch),
    deleteOldJobs(RETENTION.finishedJobDays, RETENTION.batch),
    clearExpiredFetchLocks(),
  ]);
  return { cachedPosts, rejectedCandidates, jobs, locks };
}
