import "server-only";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import db from "@/db";
import { type AccountDeletion, accountDeletionsTable, automationsTable, profilesTable, scanJobsTable } from "@/db/schema";

// Day 40.1 account deletion. The record outlives the profile it deletes.

const t = accountDeletionsTable;

export async function getDeletionByUserId(userId: string): Promise<AccountDeletion | undefined> {
  const [row] = await db.select().from(t).where(eq(t.userId, userId)).limit(1);
  return row;
}

/** Starts a deletion, or returns the one already started (a retry) */
export async function startDeletion(userId: string, profileId: string): Promise<AccountDeletion> {
  const [created] = await db.insert(t).values({ userId, profileId, status: "in_progress" }).onConflictDoNothing().returning();
  if (created) return created;
  const existing = await getDeletionByUserId(userId);
  if (!existing) throw new Error("Couldn't start the deletion.");
  return existing;
}

export async function updateDeletion(id: string, patch: Partial<Pick<AccountDeletion, "status" | "steps" | "error" | "completedAt">>): Promise<AccountDeletion> {
  const [row] = await db.update(t).set(patch).where(eq(t.id, id)).returning();
  return row;
}

/**
 * Stops everything Scout does for the profile on its own: automatic scans,
 * queued scans, automatic preparation, automations. One batch.
 */
export async function stopProcessing(profileId: string, now: Date): Promise<void> {
  await db.batch([
    db
      .update(profilesTable)
      .set({ deletionRequestedAt: now, autoScanEnabled: false, nextScanAt: null, autoPrepareEnabled: false })
      .where(eq(profilesTable.id, profileId)),
    db.update(automationsTable).set({ enabled: false }).where(eq(automationsTable.profileId, profileId)),
    db.delete(scanJobsTable).where(and(eq(scanJobsTable.profileId, profileId), inArray(scanJobsTable.status, ["pending"]))),
  ]);
}

/** Deletes the profile; everything owned by it goes with it (foreign keys cascade) */
export async function deleteProfileData(profileId: string): Promise<boolean> {
  const rows = await db.delete(profilesTable).where(eq(profilesTable.id, profileId)).returning({ id: profilesTable.id });
  return rows.length > 0;
}

export async function profileExists(profileId: string): Promise<boolean> {
  const [row] = await db.select({ id: profilesTable.id }).from(profilesTable).where(eq(profilesTable.id, profileId)).limit(1);
  return Boolean(row);
}

/** Deletions whose data step can be finished without the user (X access already revoked) */
export async function deletionsToResume(now: Date, olderThanMs: number, limit = 10): Promise<AccountDeletion[]> {
  return db
    .select()
    .from(t)
    .where(
      and(
        inArray(t.status, ["in_progress", "needs_attention"]),
        sql`coalesce((${t.steps}->>'xRevoked')::boolean, false)`,
        sql`not coalesce((${t.steps}->>'dataDeleted')::boolean, false)`,
        lt(t.updatedAt, new Date(now.getTime() - olderThanMs)),
      ),
    )
    .limit(limit);
}

/** Finished deletions are kept a while (to block re-creating the account by accident), then dropped */
export async function purgeCompletedDeletions(now: Date, days: number): Promise<number> {
  const rows = await db
    .delete(t)
    .where(and(eq(t.status, "completed"), lt(t.completedAt, new Date(now.getTime() - days * 86_400_000))))
    .returning({ id: t.id });
  return rows.length;
}
