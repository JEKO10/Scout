import "server-only";

import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import db from "@/db";
import {
  type Automation,
  type AutomationItem,
  automationItemsTable,
  type AutomationRun,
  automationRunsTable,
  automationsTable,
  contentDraftsTable,
  growthPlanTasksTable,
  growthStrategiesTable,
  leadsTable,
  opportunitiesTable,
  trendsTable,
} from "@/db/schema";
import type { AutomationInput } from "@/lib/automations/rules";
import { MAX_RUN_ATTEMPTS } from "@/lib/automations/types";

// Day 36 Automation Scout. Every user-facing query is scoped by profileId.
// Event queries read data Scout already stored; none calls X.

// ---- Definitions -------------------------------------------------------------------

export async function listAutomations(profileId: string): Promise<Automation[]> {
  return db.select().from(automationsTable).where(eq(automationsTable.profileId, profileId)).orderBy(asc(automationsTable.createdAt));
}

export async function getAutomation(profileId: string, id: string): Promise<Automation | undefined> {
  const [row] = await db
    .select()
    .from(automationsTable)
    .where(and(eq(automationsTable.profileId, profileId), eq(automationsTable.id, id)))
    .limit(1);
  return row;
}

export async function countEnabledAutomations(profileId: string, exceptId?: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(automationsTable)
    .where(
      and(
        eq(automationsTable.profileId, profileId),
        eq(automationsTable.enabled, true),
        exceptId ? sql`${automationsTable.id} <> ${exceptId}` : undefined,
      ),
    );
  return row?.n ?? 0;
}

export async function insertAutomation(profileId: string, input: AutomationInput): Promise<Automation> {
  const [row] = await db
    .insert(automationsTable)
    .values({
      profileId,
      name: input.name,
      description: input.description || null,
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      enabled: input.enabled,
      templateKey: input.templateKey ?? null,
      // cursorAt: the database's now() (default), the same clock events are stamped with
    })
    .returning();
  return row;
}

/** Edit; turning an automation back on starts from now (no replay of what happened while it was off) */
export async function updateAutomation(profileId: string, id: string, input: AutomationInput, wasEnabled: boolean) {
  const rows = await db
    .update(automationsTable)
    .set({
      name: input.name,
      description: input.description || null,
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      enabled: input.enabled,
      ...(input.enabled && !wasEnabled && { cursorAt: sql`now()` }),
      lastError: null,
    })
    .where(and(eq(automationsTable.profileId, profileId), eq(automationsTable.id, id)))
    .returning();
  return rows[0];
}

export async function setAutomationEnabled(profileId: string, id: string, enabled: boolean): Promise<boolean> {
  const rows = await db
    .update(automationsTable)
    .set({ enabled, ...(enabled && { cursorAt: sql`now()`, lastError: null }) })
    .where(and(eq(automationsTable.profileId, profileId), eq(automationsTable.id, id)))
    .returning({ id: automationsTable.id });
  return rows.length > 0;
}

export async function deleteAutomation(profileId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(automationsTable)
    .where(and(eq(automationsTable.profileId, profileId), eq(automationsTable.id, id)))
    .returning({ id: automationsTable.id });
  return rows.length > 0;
}

// ---- Engine ------------------------------------------------------------------------

/** Enabled automations nobody is processing, least recently run first */
export async function nextAutomations(now: Date, limit: number): Promise<Automation[]> {
  return db
    .select()
    .from(automationsTable)
    .where(and(eq(automationsTable.enabled, true), or(isNull(automationsTable.lockedUntil), lt(automationsTable.lockedUntil, now))))
    .orderBy(sql`${automationsTable.lastRunAt} asc nulls first`)
    .limit(limit);
}

/** One worker at a time per automation; a crashed worker's lock expires */
export async function claimAutomation(id: string, now: Date, minutes = 5): Promise<Automation | undefined> {
  const [row] = await db
    .update(automationsTable)
    .set({ lockedUntil: new Date(now.getTime() + minutes * 60_000) })
    .where(
      and(
        eq(automationsTable.id, id),
        eq(automationsTable.enabled, true),
        or(isNull(automationsTable.lockedUntil), lt(automationsTable.lockedUntil, now)),
      ),
    )
    .returning();
  return row;
}

export async function releaseAutomation(id: string, patch: Partial<Pick<Automation, "cursorAt" | "lastRunAt" | "lastError">>): Promise<void> {
  await db
    .update(automationsTable)
    .set({ ...patch, lockedUntil: null })
    .where(eq(automationsTable.id, id));
}

export async function getRunsByKeys(automationId: string, keys: string[]): Promise<Map<string, AutomationRun>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select()
    .from(automationRunsTable)
    .where(and(eq(automationRunsTable.automationId, automationId), inArray(automationRunsTable.eventKey, keys)));
  return new Map(rows.map((row) => [row.eventKey, row]));
}

/** Claims an event for an automation; null if another worker (or an earlier tick) has it */
export async function startRun(
  values: Pick<AutomationRun, "automationId" | "profileId" | "eventKey" | "entityId" | "status" | "reason" | "counted">,
): Promise<AutomationRun | null> {
  const [row] = await db.insert(automationRunsTable).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

/** A failed run whose retry is due: taken by exactly one worker */
export async function claimRetry(runId: string, now: Date): Promise<AutomationRun | null> {
  const [row] = await db
    .update(automationRunsTable)
    .set({ status: "running", attempts: sql`${automationRunsTable.attempts} + 1`, nextRetryAt: null })
    .where(
      and(
        eq(automationRunsTable.id, runId),
        eq(automationRunsTable.status, "failed"),
        lt(automationRunsTable.attempts, MAX_RUN_ATTEMPTS),
        lte(automationRunsTable.nextRetryAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

export async function finishRun(
  id: string,
  patch: Pick<AutomationRun, "status" | "reason" | "actionResults" | "aiCostUsd" | "durationMs"> & { nextRetryAt?: Date | null },
): Promise<void> {
  await db.update(automationRunsTable).set(patch).where(eq(automationRunsTable.id, id));
}

export async function retryableRuns(automationId: string, now: Date, limit = 10): Promise<AutomationRun[]> {
  return db
    .select()
    .from(automationRunsTable)
    .where(
      and(
        eq(automationRunsTable.automationId, automationId),
        eq(automationRunsTable.status, "failed"),
        lt(automationRunsTable.attempts, MAX_RUN_ATTEMPTS),
        lte(automationRunsTable.nextRetryAt, now),
      ),
    )
    .limit(limit);
}

/** Runs counted in the monthly allowance since a date */
export async function countCountedRuns(profileId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(automationRunsTable)
    .where(and(eq(automationRunsTable.profileId, profileId), eq(automationRunsTable.counted, true), gte(automationRunsTable.createdAt, since)));
  return row?.n ?? 0;
}

export async function recentRuns(profileId: string, limit = 30) {
  return db
    .select({ run: automationRunsTable, name: automationsTable.name })
    .from(automationRunsTable)
    .innerJoin(automationsTable, eq(automationsTable.id, automationRunsTable.automationId))
    .where(eq(automationRunsTable.profileId, profileId))
    .orderBy(desc(automationRunsTable.updatedAt))
    .limit(limit);
}

/** Per automation: counted runs this month and the last failure */
export async function runStatsByAutomation(profileId: string, since: Date) {
  const rows = await db
    .select({
      automationId: automationRunsTable.automationId,
      counted: sql<number>`count(*) filter (where ${automationRunsTable.counted} and ${automationRunsTable.createdAt} >= ${since})::int`,
      failed: sql<number>`count(*) filter (where ${automationRunsTable.status} = 'failed')::int`,
    })
    .from(automationRunsTable)
    .where(eq(automationRunsTable.profileId, profileId))
    .groupBy(automationRunsTable.automationId);
  return new Map(rows.map((row) => [row.automationId, row]));
}

// ---- Notifications and review queue -------------------------------------------------

export async function insertItem(values: Omit<typeof automationItemsTable.$inferInsert, "id">): Promise<boolean> {
  const rows = await db.insert(automationItemsTable).values(values).onConflictDoNothing().returning({ id: automationItemsTable.id });
  return rows.length > 0;
}

export async function listQueue(profileId: string, limit = 50): Promise<AutomationItem[]> {
  return db
    .select()
    .from(automationItemsTable)
    .where(and(eq(automationItemsTable.profileId, profileId), inArray(automationItemsTable.kind, ["review", "reminder"]), eq(automationItemsTable.status, "open")))
    .orderBy(sql`${automationItemsTable.dueAt} asc nulls last`, desc(automationItemsTable.createdAt))
    .limit(limit);
}

export async function listNotifications(profileId: string, limit = 20): Promise<AutomationItem[]> {
  return db
    .select()
    .from(automationItemsTable)
    .where(and(eq(automationItemsTable.profileId, profileId), eq(automationItemsTable.kind, "notification")))
    .orderBy(desc(automationItemsTable.createdAt))
    .limit(limit);
}

export async function countUnreadAutomationNotifications(profileId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(automationItemsTable)
    .where(and(eq(automationItemsTable.profileId, profileId), eq(automationItemsTable.kind, "notification"), isNull(automationItemsTable.readAt)))
    .limit(1);
  return row?.n ?? 0;
}

/**
 * Closes a review item or reminder, and marks the notification of the same
 * event read: the two never disagree. False: not the user's item.
 */
export async function setItemStatus(profileId: string, id: string, status: "reviewed" | "dismissed" | "done", now = new Date()): Promise<boolean> {
  const [item] = await db
    .update(automationItemsTable)
    .set({ status, readAt: now })
    .where(and(eq(automationItemsTable.profileId, profileId), eq(automationItemsTable.id, id), inArray(automationItemsTable.kind, ["review", "reminder"])))
    .returning();
  if (!item) return false;
  await db
    .update(automationItemsTable)
    .set({ readAt: now, status: "reviewed" })
    .where(
      and(
        eq(automationItemsTable.profileId, profileId),
        eq(automationItemsTable.eventKey, item.eventKey),
        eq(automationItemsTable.kind, "notification"),
        isNull(automationItemsTable.readAt),
      ),
    );
  return true;
}

export async function markNotificationsRead(profileId: string, id?: string, now = new Date()): Promise<void> {
  await db
    .update(automationItemsTable)
    .set({ readAt: now })
    .where(
      and(
        eq(automationItemsTable.profileId, profileId),
        eq(automationItemsTable.kind, "notification"),
        isNull(automationItemsTable.readAt),
        id ? eq(automationItemsTable.id, id) : undefined,
      ),
    );
}

// ---- Event sources (stored Scout data, bounded) ----------------------------------------

export async function opportunitiesAfter(profileId: string, after: Date, limit: number, ids?: string[]) {
  return db
    .select()
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.profileId, profileId),
        ids ? inArray(opportunitiesTable.id, ids) : gt(opportunitiesTable.createdAt, after),
      ),
    )
    .orderBy(asc(opportunitiesTable.createdAt))
    .limit(limit);
}

export async function leadsAfter(profileId: string, after: Date, limit: number, ids?: string[]) {
  return db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.profileId, profileId), ids ? inArray(leadsTable.id, ids) : gt(leadsTable.createdAt, after)))
    .orderBy(asc(leadsTable.createdAt))
    .limit(limit);
}

export async function trendsAfter(profileId: string, after: Date, limit: number, ids?: string[]) {
  return db
    .select()
    .from(trendsTable)
    .where(and(eq(trendsTable.profileId, profileId), ids ? inArray(trendsTable.id, ids) : gt(trendsTable.updatedAt, after)))
    .orderBy(asc(trendsTable.updatedAt))
    .limit(limit);
}

/** Follow-ups due in the window [from, to], not done */
export async function followUpsDue(profileId: string, from: Date, to: Date, limit: number, ids?: string[]) {
  return db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.profileId, profileId),
        isNull(leadsTable.followUpDoneAt),
        ids ? inArray(leadsTable.id, ids) : and(gte(leadsTable.followUpAt, from), lte(leadsTable.followUpAt, to)),
      ),
    )
    .orderBy(asc(leadsTable.followUpAt))
    .limit(limit);
}

/** Planned posts due in the window, not posted or archived */
export async function contentDue(profileId: string, from: Date, to: Date, limit: number, ids?: string[]) {
  return db
    .select()
    .from(contentDraftsTable)
    .where(
      and(
        eq(contentDraftsTable.profileId, profileId),
        isNull(contentDraftsTable.archivedAt),
        isNull(contentDraftsTable.publishedConfirmedAt),
        ids ? inArray(contentDraftsTable.id, ids) : and(gte(contentDraftsTable.plannedAt, from), lte(contentDraftsTable.plannedAt, to)),
      ),
    )
    .orderBy(asc(contentDraftsTable.plannedAt))
    .limit(limit);
}

/** To-do tasks of the user's active plan whose day is in [fromDay, toDay] */
export async function strategyTasksDue(profileId: string, fromDay: string, toDay: string, limit: number, ids?: string[]) {
  return db
    .select({ task: growthPlanTasksTable })
    .from(growthPlanTasksTable)
    .innerJoin(growthStrategiesTable, eq(growthStrategiesTable.id, growthPlanTasksTable.strategyId))
    .where(
      and(
        eq(growthPlanTasksTable.profileId, profileId),
        eq(growthStrategiesTable.status, "active"),
        eq(growthPlanTasksTable.status, "todo"),
        ids ? inArray(growthPlanTasksTable.id, ids) : and(gte(growthPlanTasksTable.day, fromDay), lte(growthPlanTasksTable.day, toDay)),
      ),
    )
    .orderBy(asc(growthPlanTasksTable.day), asc(growthPlanTasksTable.position))
    .limit(limit);
}

/** AI spend recorded for a profile since a moment (an automation run's AI actions) */
export async function aiCostSince(profileId: string, since: Date): Promise<number> {
  const result = await db.execute<{ cost: number }>(sql`
    select coalesce(sum("costUsd"), 0)::float8 as cost
    from ai_usage
    where "profileId" = ${profileId}::uuid and "createdAt" >= ${since.toISOString()}::timestamptz
      and "operation" in ('reply_generation', 'trend_insight')
  `);
  return Number(result.rows[0]?.cost ?? 0);
}

/** Retention: run history after 90 days; closed queue items and read notifications after 90 days */
export async function deleteOldAutomationRecords(now = new Date(), days = 90): Promise<number> {
  const before = new Date(now.getTime() - days * 86_400_000);
  const runs = await db
    .delete(automationRunsTable)
    .where(and(lt(automationRunsTable.createdAt, before), sql`${automationRunsTable.status} <> 'running'`))
    .returning({ id: automationRunsTable.id });
  const items = await db
    .delete(automationItemsTable)
    .where(and(lt(automationItemsTable.createdAt, before), or(sql`${automationItemsTable.status} <> 'open'`, sql`${automationItemsTable.readAt} is not null`)))
    .returning({ id: automationItemsTable.id });
  return runs.length + items.length;
}
