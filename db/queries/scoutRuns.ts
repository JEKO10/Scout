import "server-only";

import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";

import db from "@/db";
import { type ScoutRun, scoutRunsTable } from "@/db/schema";
import type { ScoutRunStats } from "@/lib/scout/types";

const ACTIVE_STATUSES = ["pending", "running"] as const;

export type RunLimits = {
  maxRunsPerDay: number | null;
  minMinutesBetweenRuns: number | null;
};

/**
 * Starts a run, or returns null when the profile already has an active one or
 * a run limit says no. One statement: the limit checks and the insert can't be
 * split by a concurrent request, and the partial unique index allows one
 * pending/running run per profile, so double clicks can't both start a scan.
 * Failed runs don't count, so a failure never blocks the next try.
 */
export async function startScoutRun(
  profileId: string,
  limits: RunLimits = { maxRunsPerDay: null, minMinutesBetweenRuns: null },
): Promise<ScoutRun | null> {
  const { maxRunsPerDay, minMinutesBetweenRuns } = limits;
  const result = await db.execute<{ id: string }>(sql`
    insert into ${scoutRunsTable} ("profileId", "status", "startedAt")
    select ${profileId}::uuid, 'running'::scout_run_status, now()
    where (
      ${maxRunsPerDay}::int is null
      or (
        select count(*) from ${scoutRunsTable}
        where "profileId" = ${profileId}::uuid
          and "status" <> 'failed'
          and "createdAt" > now() - interval '24 hours'
      ) < ${maxRunsPerDay}::int
    )
    and (
      ${minMinutesBetweenRuns}::int is null
      or not exists (
        select 1 from ${scoutRunsTable}
        where "profileId" = ${profileId}::uuid
          and "status" = 'completed'
          and "startedAt" > now() - make_interval(mins => ${minMinutesBetweenRuns}::int)
      )
    )
    on conflict ("profileId") where "status" in ('pending', 'running') do nothing
    returning "id"
  `);
  const id = result.rows[0]?.id;
  if (!id) return null;
  // The database clock set startedAt: it becomes each account's lastScannedAt
  // watermark and is compared with DB-set import times
  const [run] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, id));
  return run;
}

export type RunGate = {
  /** Non-failed runs in the last 24 hours, the active one included */
  runsLast24h: number;
  active: boolean;
  lastCompletedAt: Date | null;
  /** When a new run is allowed; null: now */
  nextEligibleAt: Date | null;
  blockedBy: "active" | "daily_limit" | "min_gap" | null;
};

/** Why a run would be refused right now, for messages and the dashboard. */
export async function getRunGate(profileId: string, limits: RunLimits): Promise<RunGate> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const runs = await db
    .select({
      status: scoutRunsTable.status,
      createdAt: scoutRunsTable.createdAt,
      startedAt: scoutRunsTable.startedAt,
      completedAt: scoutRunsTable.completedAt,
    })
    .from(scoutRunsTable)
    .where(and(eq(scoutRunsTable.profileId, profileId), gt(scoutRunsTable.createdAt, since)))
    .orderBy(asc(scoutRunsTable.createdAt));

  const counted = runs.filter((run) => run.status !== "failed");
  const active = runs.some((run) => ACTIVE_STATUSES.some((status) => status === run.status));
  const lastCompleted = counted.filter((run) => run.status === "completed").at(-1);

  const waits: { until: Date; reason: "daily_limit" | "min_gap" }[] = [];
  if (limits.maxRunsPerDay !== null && counted.length >= limits.maxRunsPerDay) {
    // The window frees up when the oldest counted run leaves it
    const oldest = counted[counted.length - limits.maxRunsPerDay];
    waits.push({
      until: new Date(oldest.createdAt.getTime() + 24 * 60 * 60_000),
      reason: "daily_limit",
    });
  }
  if (limits.minMinutesBetweenRuns !== null && lastCompleted) {
    const start = lastCompleted.startedAt ?? lastCompleted.createdAt;
    const until = new Date(start.getTime() + limits.minMinutesBetweenRuns * 60_000);
    if (until.getTime() > Date.now()) waits.push({ until, reason: "min_gap" });
  }
  const wait = waits.sort((a, b) => b.until.getTime() - a.until.getTime())[0];

  return {
    runsLast24h: counted.length,
    active,
    lastCompletedAt: lastCompleted?.completedAt ?? null,
    nextEligibleAt: wait?.until ?? null,
    blockedBy: active ? "active" : (wait?.reason ?? null),
  };
}

export async function getActiveScoutRun(
  profileId: string,
): Promise<ScoutRun | undefined> {
  const [run] = await db
    .select()
    .from(scoutRunsTable)
    .where(
      and(
        eq(scoutRunsTable.profileId, profileId),
        inArray(scoutRunsTable.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(1);
  return run;
}

/** Frees the slot held by a run that died mid-scan (crash, deploy, timeout). */
export async function failStaleScoutRuns(
  profileId: string,
  startedBefore: Date,
): Promise<void> {
  await db
    .update(scoutRunsTable)
    .set({
      status: "failed",
      error: "Timed out: the scan stopped without finishing.",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(scoutRunsTable.profileId, profileId),
        inArray(scoutRunsTable.status, [...ACTIVE_STATUSES]),
        lt(scoutRunsTable.createdAt, startedBefore),
      ),
    );
}

export async function finishScoutRun(
  runId: string,
  outcome:
    | { status: "completed"; stats: ScoutRunStats }
    | { status: "failed"; error: string; stats?: ScoutRunStats },
): Promise<ScoutRun> {
  const [run] = await db
    .update(scoutRunsTable)
    .set({
      status: outcome.status,
      stats: outcome.stats ?? null,
      opportunitiesFound: outcome.stats?.scoring?.surfaced ?? 0,
      error: outcome.status === "failed" ? outcome.error : null,
      completedAt: new Date(),
    })
    .where(eq(scoutRunsTable.id, runId))
    .returning();
  return run;
}

export async function getRecentScoutRuns(
  profileId: string,
  limit = 5,
): Promise<ScoutRun[]> {
  return db
    .select()
    .from(scoutRunsTable)
    .where(eq(scoutRunsTable.profileId, profileId))
    .orderBy(desc(scoutRunsTable.createdAt))
    .limit(limit);
}
