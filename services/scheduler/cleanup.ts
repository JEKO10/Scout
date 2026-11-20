import "server-only";

import { deleteOldAutomationRecords } from "@/db/queries/automations";
import {
  clearExpiredFetchLocks,
  deleteExpiredCachedPosts,
  deleteOldJobs,
  deleteOldRejectedCandidates,
} from "@/db/queries/cleanup";
import { deleteOldAnalyticsEvents } from "@/db/queries/compliance";
import { deleteOldPeerStats } from "@/db/queries/peers";
import { isMissingSchemaError, missingSchemaMessage } from "@/db/schemaErrors";
import { ANALYTICS_RETENTION_DAYS, RETENTION_BATCH } from "@/lib/compliance/retention";
import { resumeAccountDeletions } from "@/services/account/deleteAccount";
import { applyRetention } from "@/services/compliance/xCompliance";

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
 * - Peer post stats (Day 35, numbers only, no text): 90 days after the post.
 * - Automation runs, closed queue items and read notifications (Day 36): 90 days.
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
  const [cachedPosts, rejectedCandidates, jobs, locks, peerStats, automationRecords] = await Promise.all([
    deleteExpiredCachedPosts(RETENTION.cachedPostDays, RETENTION.batch),
    deleteOldRejectedCandidates(RETENTION.rejectedCandidateDays, RETENTION.batch),
    deleteOldJobs(RETENTION.finishedJobDays, RETENTION.batch),
    clearExpiredFetchLocks(),
    // Day 35: derived peer post numbers, 90 days (null: the table isn't there yet; logged)
    deleteOldPeerStats().catch((error: unknown) => {
      if (!isMissingSchemaError(error)) throw error;
      console.error(missingSchemaMessage("Peer stats cleanup", "20261118002427_peer_intelligence"));
      return null;
    }),
    // Day 36: automation history and closed queue items, 90 days
    deleteOldAutomationRecords().catch((error: unknown) => {
      if (!isMissingSchemaError(error)) throw error;
      console.error(missingSchemaMessage("Automation cleanup", "20261118195718_automation_scout"));
      return null;
    }),
  ]);
  return { cachedPosts, rejectedCandidates, jobs, locks, peerStats, automationRecords, ...(await runHourlyRetention()) };
}

/**
 * Day 40.1: third-party X text past Scout's retention, and old analytics
 * events. Once an hour (the first tick of each hour), bounded batches, no
 * API calls. Skipped, and reported, while the compliance migration is pending.
 */
export async function runHourlyRetention(now = new Date(), { force = false } = {}) {
  if (!force && now.getUTCMinutes() >= 5) return {};
  try {
    const [thirdParty, analyticsEvents, deletions] = await Promise.all([
      applyRetention(now),
      deleteOldAnalyticsEvents(ANALYTICS_RETENTION_DAYS, now, RETENTION_BATCH),
      resumeAccountDeletions(now),
    ]);
    return { thirdParty, analyticsEvents, deletions };
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    console.error(missingSchemaMessage("Content retention", "compliance_hardening"));
    return {};
  }
}
