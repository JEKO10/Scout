import "server-only";

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import db from "@/db";
import {
  profilesTable,
  type ScanJob,
  scanJobsTable,
  scoutRunsTable,
} from "@/db/schema";

// Durable state for Automatic Scout. Every step is one SQL statement, so any
// number of scheduler instances can run at once without double work.

/**
 * Queues a job for every profile with Automatic Scout on whose next scan is
 * due and that has no open job. The partial unique index (one open job per
 * profile) is the final guard when two schedulers queue at the same moment.
 */
export async function enqueueDueJobs(limit: number): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    insert into ${scanJobsTable} ("profileId", "runAfter")
    select p."id", now()
    from ${profilesTable} p
    where p."autoScanEnabled" = true
      and p."onboardingCompleted" = true
      and p."nextScanAt" <= now()
      and not exists (
        select 1 from ${scanJobsTable} j
        where j."profileId" = p."id" and j."status" in ('pending', 'running')
      )
    order by p."nextScanAt"
    limit ${limit}
    on conflict ("profileId") where "status" in ('pending', 'running') do nothing
    returning "id"
  `);
  return result.rows.length;
}

/**
 * Claims the next due job for this worker, or null. SKIP LOCKED lets parallel
 * workers take different jobs; nothing is claimed while `maxRunning` scans
 * (automatic jobs and manual runs) are already running.
 */
export async function claimNextJob(
  workerId: string,
  { maxRunning, lockMinutes }: { maxRunning: number; lockMinutes: number },
): Promise<ScanJob | null> {
  const result = await db.execute<{ id: string }>(sql`
    update ${scanJobsTable}
    set "status" = 'running',
        "lockedBy" = ${workerId},
        "lockedUntil" = now() + make_interval(mins => ${lockMinutes}),
        "startedAt" = now(),
        "attempts" = "attempts" + 1,
        "updatedAt" = now()
    where "id" = (
      select "id" from ${scanJobsTable}
      where "status" = 'pending' and "runAfter" <= now()
        and (
          (select count(*) from ${scanJobsTable} where "status" = 'running')
          + (select count(*) from ${scoutRunsTable}
             where "status" in ('pending', 'running') and "trigger" = 'manual')
        ) < ${maxRunning}
      order by "runAfter"
      limit 1
      for update skip locked
    )
    returning "id"
  `);
  const id = result.rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(scanJobsTable).where(eq(scanJobsTable.id, id));
  return job;
}

type Finish =
  | { status: "completed"; scoutRunId: string | null; busyAccounts: number }
  | { status: "skipped"; skipReason: string; scoutRunId?: string | null }
  | { status: "failed"; error: string; scoutRunId?: string | null };

/** Closes a job this worker holds. False when the claim was lost (expired and reaped). */
export async function finishJob(job: ScanJob, workerId: string, finish: Finish): Promise<boolean> {
  const rows = await db
    .update(scanJobsTable)
    .set({
      status: finish.status,
      skipReason: finish.status === "skipped" ? finish.skipReason : null,
      error: finish.status === "failed" ? finish.error.slice(0, 1000) : null,
      scoutRunId: "scoutRunId" in finish ? (finish.scoutRunId ?? null) : null,
      busyAccounts: finish.status === "completed" ? finish.busyAccounts : 0,
      finishedAt: sql`now()`,
      durationMs: job.startedAt ? sql`(extract(epoch from now() - ${scanJobsTable.startedAt}) * 1000)::int` : null,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(and(eq(scanJobsTable.id, job.id), eq(scanJobsTable.lockedBy, workerId)))
    .returning({ id: scanJobsTable.id });
  return rows.length > 0;
}

/** A failed attempt that will be tried again later; the job stays open. */
export async function retryJobLater(
  job: ScanJob,
  workerId: string,
  { error, delayMinutes }: { error: string; delayMinutes: number },
): Promise<boolean> {
  const rows = await db
    .update(scanJobsTable)
    .set({
      status: "pending",
      error: error.slice(0, 1000),
      runAfter: sql`now() + make_interval(mins => ${delayMinutes})`,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(and(eq(scanJobsTable.id, job.id), eq(scanJobsTable.lockedBy, workerId)))
    .returning({ id: scanJobsTable.id });
  return rows.length > 0;
}

/**
 * Jobs whose worker died (claim expired while running): back to pending with
 * a short delay, or failed after the last attempt. Returns how many.
 */
export async function reapExpiredJobs(maxAttempts: number): Promise<number> {
  const rows = await db
    .update(scanJobsTable)
    .set({
      status: sql`case when ${scanJobsTable.attempts} >= ${maxAttempts} then 'failed' else 'pending' end::scan_job_status`,
      error: sql`coalesce(${scanJobsTable.error}, 'The worker stopped before finishing.')`,
      runAfter: sql`now() + interval '5 minutes'`,
      finishedAt: sql`case when ${scanJobsTable.attempts} >= ${maxAttempts} then now() end`,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(and(eq(scanJobsTable.status, "running"), lt(scanJobsTable.lockedUntil, sql`now()`)))
    .returning({ id: scanJobsTable.id });
  return rows.length;
}

/** Automatic runs that completed for the profile in the last 24 hours. */
export async function countAutoRunsLast24h(profileId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(scanJobsTable)
    .where(
      and(
        eq(scanJobsTable.profileId, profileId),
        eq(scanJobsTable.status, "completed"),
        gte(scanJobsTable.finishedAt, sql`now() - interval '24 hours'`),
      ),
    );
  return row.value;
}

/** When the scheduler should look at this profile again; also records the last auto scan. */
export async function scheduleNextScan(
  profileId: string,
  { inMinutes, at, scanned }: { inMinutes?: number; at?: Date; scanned?: boolean },
): Promise<void> {
  await db
    .update(profilesTable)
    .set({
      nextScanAt: at ?? sql`now() + make_interval(mins => ${inMinutes ?? 30})`,
      ...(scanned && { lastAutoScanAt: sql`now()` }),
    })
    .where(eq(profilesTable.id, profileId));
}

export async function getRecentJobs(profileId: string, limit = 10): Promise<ScanJob[]> {
  return db
    .select()
    .from(scanJobsTable)
    .where(eq(scanJobsTable.profileId, profileId))
    .orderBy(desc(scanJobsTable.createdAt))
    .limit(limit);
}

export type JobStats = {
  status: ScanJob["status"];
  skipReason: string | null;
  jobs: number;
  avgDurationMs: number | null;
  busyAccounts: number;
};

/** Counts per status and skip reason since a moment, for monitoring. */
export async function getJobStats(since: Date, profileId?: string): Promise<JobStats[]> {
  return db
    .select({
      status: scanJobsTable.status,
      skipReason: scanJobsTable.skipReason,
      jobs: sql<number>`count(*)::int`,
      avgDurationMs: sql<number | null>`avg(${scanJobsTable.durationMs})::int`,
      busyAccounts: sql<number>`coalesce(sum(${scanJobsTable.busyAccounts}), 0)::int`,
    })
    .from(scanJobsTable)
    .where(
      and(
        gte(scanJobsTable.createdAt, since),
        profileId ? eq(scanJobsTable.profileId, profileId) : undefined,
      ),
    )
    .groupBy(scanJobsTable.status, scanJobsTable.skipReason);
}
