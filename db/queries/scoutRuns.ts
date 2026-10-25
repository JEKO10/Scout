import "server-only";

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import db from "@/db";
import { type ScoutRun, scoutRunsTable } from "@/db/schema";
import type { ScoutRunStats } from "@/lib/scout/types";

const ACTIVE_STATUSES = ["pending", "running"] as const;

/**
 * Starts a run, or returns null when the profile already has an active one.
 * The partial unique index allows one pending/running run per profile, so two
 * clicks at the same moment can't both start a scan.
 */
export async function startScoutRun(profileId: string): Promise<ScoutRun | null> {
  const [run] = await db
    .insert(scoutRunsTable)
    // The database clock, not the app's: startedAt becomes each account's
    // lastScannedAt watermark and is compared with DB-set import times
    .values({ profileId, status: "running", startedAt: sql`now()` })
    .onConflictDoNothing({
      target: scoutRunsTable.profileId,
      where: sql`${scoutRunsTable.status} in ('pending', 'running')`,
    })
    .returning();
  return run ?? null;
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
