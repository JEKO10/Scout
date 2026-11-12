import "server-only";

import { randomUUID } from "node:crypto";

import { getProfileById } from "@/db/queries/profiles";
import {
  claimNextJob,
  countAutoRunsLast24h,
  enqueueDueJobs,
  finishJob,
  reapExpiredJobs,
  retryJobLater,
  scheduleNextScan,
} from "@/db/queries/scanJobs";
import { getXUsageToday } from "@/db/queries/xApiUsage";
import type { Profile, ScanJob } from "@/db/schema";
import { PLANS } from "@/lib/billing/plans";
import { getScoutLimits } from "@/lib/scout/testLimits";
import { currentPeriodStart } from "@/services/billing/budget";
import { deliverPendingNotifications, type DeliveryTickResult } from "@/services/notifications/deliver";
import { queueRunNotifications } from "@/services/notifications/queue";
import { runScout } from "@/services/scout/runScout";

import { runCleanup } from "./cleanup";

/**
 * Automatic Scout (Day 18). A planner (Vercel Cron, GitHub Actions…) calls
 * the scheduler endpoint every few minutes; each call is one bounded tick:
 * queue the users whose next scan is due, then claim and run jobs until the
 * time budget or the job cap is reached. Unfinished work waits for the next
 * tick, so no request runs unbounded. All state lives in Postgres, so any
 * number of instances can tick at once.
 */
export const SCHEDULER = {
  /** Stop claiming new jobs after this; a Vercel function may run 300 s */
  timeBudgetMs: 200_000,
  maxJobsPerTick: 10,
  /** Users queued per tick */
  enqueuePerTick: 50,
  /** A claimed job is reaped after this (the worker died) */
  jobLockMinutes: 10,
  maxAttempts: 3,
  /** Retry delay: 5, 10, 20… minutes, at most 60 */
  backoffBaseMinutes: 5,
  backoffMaxMinutes: 60,
  /** A manual run is active: look again shortly */
  scanRunningRetryMinutes: 5,
};

export type JobOutcome = {
  jobId: string;
  profileId: string;
  status: "completed" | "skipped" | "failed" | "retry";
  reason?: string;
  /** Completed scans: notifications created, or why queueing them failed */
  notified?: number;
  notifyError?: string;
};

export type TickResult = {
  workerId: string;
  reaped: number;
  enqueued: number;
  outcomes: JobOutcome[];
  stoppedBy: "no_jobs" | "max_jobs" | "time_budget";
  /** Day 19: Slack alerts sent (or retried) after the scans */
  deliveries?: DeliveryTickResult;
  cleanup?: Awaited<ReturnType<typeof runCleanup>>;
};

export async function runSchedulerTick({
  workerId = randomUUID(),
  maxJobs = SCHEDULER.maxJobsPerTick,
  timeBudgetMs = SCHEDULER.timeBudgetMs,
  cleanup = true,
}: {
  workerId?: string;
  maxJobs?: number;
  timeBudgetMs?: number;
  cleanup?: boolean;
} = {}): Promise<TickResult> {
  const started = Date.now();
  const reaped = await reapExpiredJobs(SCHEDULER.maxAttempts);
  const enqueued = await enqueueDueJobs(SCHEDULER.enqueuePerTick);

  const outcomes: JobOutcome[] = [];
  let stoppedBy: TickResult["stoppedBy"] = "no_jobs";
  while (true) {
    if (outcomes.length >= maxJobs) {
      stoppedBy = "max_jobs";
      break;
    }
    if (Date.now() - started > timeBudgetMs) {
      stoppedBy = "time_budget";
      break;
    }
    const job = await claimNextJob(workerId, {
      maxRunning: getScoutLimits().maxConcurrentScans,
      lockMinutes: SCHEDULER.jobLockMinutes,
    });
    if (!job) break;
    outcomes.push(await processJob(job, workerId));
  }

  const result: TickResult = { workerId, reaped, enqueued, outcomes, stoppedBy };
  // Its own small budget, so alerts from these scans go out in this same tick
  try {
    result.deliveries = await deliverPendingNotifications({ workerId });
  } catch (caught) {
    // Queued deliveries stay in Postgres; the next tick tries again
    console.error("Notification delivery failed", caught);
  }
  if (cleanup && Date.now() - started < timeBudgetMs) result.cleanup = await runCleanup();
  return result;
}

/** The interval the user picked, if their plan offers it; else the plan's default. */
export function autoScanInterval(profile: Pick<Profile, "plan" | "autoScanIntervalMinutes">): number {
  const { intervalsMinutes } = PLANS[profile.plan].autoScan;
  return profile.autoScanIntervalMinutes && intervalsMinutes.includes(profile.autoScanIntervalMinutes)
    ? profile.autoScanIntervalMinutes
    : intervalsMinutes[0];
}

/** Whether today's global X caps (requests or post reads) are reached. */
async function globalXBudgetReached(): Promise<boolean> {
  const { maxXRequestsPerDay, maxXPostReadsPerDay } = getScoutLimits();
  if (maxXRequestsPerDay === null && maxXPostReadsPerDay === null) return false;
  const today = await getXUsageToday();
  return (
    (maxXRequestsPerDay !== null && (today?.requests ?? 0) >= maxXRequestsPerDay) ||
    (maxXPostReadsPerDay !== null && (today?.postsReturned ?? 0) >= maxXPostReadsPerDay)
  );
}

function nextUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function nextUtcMonth(): Date {
  const start = currentPeriodStart();
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

async function processJob(job: ScanJob, workerId: string): Promise<JobOutcome> {
  const outcome = (status: JobOutcome["status"], reason?: string): JobOutcome => ({
    jobId: job.id,
    profileId: job.profileId,
    status,
    reason,
  });
  const skip = async (reason: string, next: { inMinutes?: number; at?: Date } | null, scoutRunId?: string) => {
    await finishJob(job, workerId, { status: "skipped", skipReason: reason, scoutRunId });
    if (next) await scheduleNextScan(job.profileId, next);
    return outcome("skipped", reason);
  };

  const profile = await getProfileById(job.profileId);
  // Turned off after the job was queued: nothing to schedule
  if (!profile?.autoScanEnabled) return skip("disabled", null);
  const interval = autoScanInterval(profile);

  // Checked before anything costs money. Recorded as skips, not silence.
  if (await globalXBudgetReached()) return skip("global_x_budget", { at: nextUtcDay() });
  if ((await countAutoRunsLast24h(profile.id)) >= PLANS[profile.plan].autoScan.maxAutoRunsPerDay) {
    return skip("daily_auto_limit", { inMinutes: interval });
  }

  let error: string;
  let scoutRunId: string | undefined;
  try {
    // lockWaitMs 0: an account another worker is fetching is skipped, not waited on
    const result = await runScout(profile.id, { trigger: "auto", lockWaitMs: 0 });
    switch (result.status) {
      case "completed":
        await finishJob(job, workerId, {
          status: "completed",
          scoutRunId: result.run.id,
          busyAccounts: result.stats.sharedFetch?.busy ?? 0,
        });
        await scheduleNextScan(profile.id, { inMinutes: interval, scanned: true });
        // A notification problem must never fail the scan that already succeeded
        try {
          const queued = await queueRunNotifications(profile.id, result.run.id);
          return { ...outcome("completed"), notified: queued.notified };
        } catch (caught) {
          return { ...outcome("completed"), notifyError: caught instanceof Error ? caught.message : String(caught) };
        }
      case "budget_exhausted":
        return skip(`budget_${result.reason}`, { at: nextUtcMonth() });
      case "limited":
        return skip("run_limit", result.gate.nextEligibleAt ? { at: result.gate.nextEligibleAt } : { inMinutes: interval });
      case "already_running":
        return skip("scan_running", { inMinutes: SCHEDULER.scanRunningRetryMinutes });
      case "no_active_accounts":
        return skip("no_active_accounts", { inMinutes: interval });
      case "failed":
        error = result.error;
        scoutRunId = result.run.id;
        break;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  // Bounded exponential backoff, then give up until the next regular scan
  if (job.attempts < SCHEDULER.maxAttempts) {
    const delayMinutes = Math.min(
      SCHEDULER.backoffBaseMinutes * 2 ** (job.attempts - 1),
      SCHEDULER.backoffMaxMinutes,
    );
    await retryJobLater(job, workerId, { error, delayMinutes });
    return outcome("retry", error);
  }
  await finishJob(job, workerId, { status: "failed", error, scoutRunId });
  await scheduleNextScan(profile.id, { inMinutes: interval });
  return outcome("failed", error);
}
