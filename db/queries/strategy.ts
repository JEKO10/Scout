import "server-only";

import { and, asc, count, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import db from "@/db";
import {
  contentDraftsTable,
  type ExperimentObservation,
  type GrowthExperiment,
  growthExperimentsTable,
  growthPlanTasksTable,
  growthStrategiesTable,
  type GrowthStrategy,
  leadsTable,
  trendsTable,
  watchlistAccountsTable,
} from "@/db/schema";
import type { ValidExperiment, ValidTask } from "@/lib/strategy/plan";
import type { StrategyContent, StrategyEvidence } from "@/lib/strategy/types";

// Day 34 Growth Strategist. Every query is scoped by profileId: a user can
// only ever read or change their own strategies, tasks and experiments.

// ---- Inputs from other modules (counts only) --------------------------------------

export async function getStrategyModuleCounts(profileId: string, now: Date) {
  const in7 = new Date(now.getTime() + 7 * 86_400_000);
  const ago30 = new Date(now.getTime() - 30 * 86_400_000);
  const [leads, drafts, trends, watched] = await Promise.all([
    db
      .select({
        highIntentNew: sql<number>`count(*) filter (where ${leadsTable.intent} = 'high' and ${leadsTable.status} = 'new')::int`,
        total: count(),
      })
      .from(leadsTable)
      .where(eq(leadsTable.profileId, profileId)),
    db
      .select({
        ready: sql<number>`count(*) filter (where ${contentDraftsTable.status} = 'ready' and ${contentDraftsTable.publishedConfirmedAt} is null)::int`,
        planned: sql<number>`count(*) filter (where ${contentDraftsTable.plannedAt} >= ${now} and ${contentDraftsTable.plannedAt} < ${in7})::int`,
        confirmed: sql<number>`count(*) filter (where ${contentDraftsTable.publishedConfirmedAt} >= ${ago30})::int`,
      })
      .from(contentDraftsTable)
      .where(and(eq(contentDraftsTable.profileId, profileId), isNull(contentDraftsTable.archivedAt))),
    db
      .select({ label: trendsTable.label, status: trendsTable.status, postCount: trendsTable.postCount, authorCount: trendsTable.authorCount })
      .from(trendsTable)
      .where(and(eq(trendsTable.profileId, profileId), inArray(trendsTable.status, ["emerging", "rising"])))
      .orderBy(desc(trendsTable.opportunityScore), desc(trendsTable.score))
      .limit(3),
    db
      .select({ handle: watchlistAccountsTable.handle })
      .from(watchlistAccountsTable)
      .where(and(eq(watchlistAccountsTable.profileId, profileId), eq(watchlistAccountsTable.isActive, true)))
      .limit(6),
  ]);
  return {
    leads: { highIntentNew: leads[0]?.highIntentNew ?? 0, total: leads[0]?.total ?? 0 },
    content: { readyDrafts: drafts[0]?.ready ?? 0, plannedNext7: drafts[0]?.planned ?? 0, confirmedLast30: drafts[0]?.confirmed ?? 0 },
    trends,
    watchedHandles: watched.map((w) => w.handle),
  };
}

// ---- Strategies ------------------------------------------------------------------

export async function getActiveStrategy(profileId: string): Promise<GrowthStrategy | undefined> {
  const [row] = await db
    .select()
    .from(growthStrategiesTable)
    .where(and(eq(growthStrategiesTable.profileId, profileId), eq(growthStrategiesTable.status, "active")))
    .orderBy(desc(growthStrategiesTable.createdAt))
    .limit(1);
  return row;
}

export async function getStrategy(profileId: string, id: string): Promise<GrowthStrategy | undefined> {
  const [row] = await db
    .select()
    .from(growthStrategiesTable)
    .where(and(eq(growthStrategiesTable.profileId, profileId), eq(growthStrategiesTable.id, id)))
    .limit(1);
  return row;
}

/** Past and current strategies with how much of each plan got done */
export async function getStrategyHistory(profileId: string, limit = 12) {
  return db
    .select({
      id: growthStrategiesTable.id,
      status: growthStrategiesTable.status,
      mode: growthStrategiesTable.mode,
      objective: growthStrategiesTable.objective,
      weekStart: growthStrategiesTable.weekStart,
      createdAt: growthStrategiesTable.createdAt,
      // Fully qualified: inside the subquery an unqualified "id" would be the task's own
      tasks: sql<number>`(select count(*)::int from "growth_plan_tasks" t where t."strategyId" = "growth_strategies"."id")`,
      done: sql<number>`(select count(*)::int from "growth_plan_tasks" t where t."strategyId" = "growth_strategies"."id" and t."status" = 'done')`,
    })
    .from(growthStrategiesTable)
    .where(and(eq(growthStrategiesTable.profileId, profileId), inArray(growthStrategiesTable.status, ["active", "archived"])))
    .orderBy(desc(growthStrategiesTable.createdAt))
    .limit(limit);
}

/**
 * Starts a generation. Returns null while another one runs for this profile
 * (the partial unique index allows one "generating" row). A generation left
 * by a crashed request is failed after `staleMinutes`.
 */
export async function startStrategyGeneration(
  profileId: string,
  values: Pick<GrowthStrategy, "mode" | "objective" | "weeklyMinutes" | "weekStart" | "evidence" | "evidenceKey" | "stage" | "peerMode">,
  now = new Date(),
  staleMinutes = 3,
): Promise<GrowthStrategy | null> {
  await db
    .update(growthStrategiesTable)
    .set({ status: "failed", error: "timed out" })
    .where(
      and(
        eq(growthStrategiesTable.profileId, profileId),
        eq(growthStrategiesTable.status, "generating"),
        lt(growthStrategiesTable.createdAt, new Date(now.getTime() - staleMinutes * 60_000)),
      ),
    );
  const [row] = await db
    .insert(growthStrategiesTable)
    .values({ profileId, status: "generating", ...values })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function failStrategyGeneration(id: string, error: string): Promise<void> {
  await db.update(growthStrategiesTable).set({ status: "failed", error: error.slice(0, 500) }).where(eq(growthStrategiesTable.id, id));
}

/**
 * The new strategy becomes the active one with its tasks and proposed
 * experiments; the previous active strategy becomes history. One batch.
 */
export async function completeStrategyGeneration(
  profileId: string,
  strategyId: string,
  {
    content,
    tasks,
    experiments,
    days,
    model,
    costUsd,
  }: { content: StrategyContent; tasks: ValidTask[]; experiments: ValidExperiment[]; days: string[]; model: string; costUsd: number | null },
): Promise<void> {
  const queries: [BatchItem<"pg">, ...BatchItem<"pg">[]] = [
    db
      .update(growthStrategiesTable)
      .set({ status: "archived" })
      .where(and(eq(growthStrategiesTable.profileId, profileId), eq(growthStrategiesTable.status, "active"), ne(growthStrategiesTable.id, strategyId))),
    // Proposals nobody started are replaced by the new strategy's
    db
      .delete(growthExperimentsTable)
      .where(and(eq(growthExperimentsTable.profileId, profileId), eq(growthExperimentsTable.status, "proposed"))),
    db.update(growthStrategiesTable).set({ status: "active", content, model, costUsd }).where(eq(growthStrategiesTable.id, strategyId)),
  ];
  if (tasks.length) {
    queries.push(
          db.insert(growthPlanTasksTable).values(
            tasks.map((task) => ({
              strategyId,
              profileId,
              day: days[task.day],
              position: task.position,
              title: task.title,
              objective: task.objective,
              activity: task.activity,
              reason: task.reason,
              effortMinutes: task.effortMinutes,
              module: task.module,
              evidenceIds: task.evidenceIds,
            })),
          ),
    );
  }
  if (experiments.length) {
    queries.push(db.insert(growthExperimentsTable).values(experiments.map((e) => ({ profileId, strategyId, ...e }))));
  }
  // One transaction: the page never sees a strategy without its plan
  await db.batch(queries);
}

// ---- Tasks -----------------------------------------------------------------------

export async function getPlanTasks(profileId: string, strategyId: string) {
  return db
    .select()
    .from(growthPlanTasksTable)
    .where(and(eq(growthPlanTasksTable.profileId, profileId), eq(growthPlanTasksTable.strategyId, strategyId)))
    .orderBy(asc(growthPlanTasksTable.day), asc(growthPlanTasksTable.position));
}

/** Done / skipped / back to to-do, or another day of the same plan. False: not the user's task. */
export async function updatePlanTask(
  profileId: string,
  taskId: string,
  change: { status: "todo" | "done" | "skipped" } | { day: string },
  now = new Date(),
): Promise<boolean> {
  const set =
    "status" in change
      ? { status: change.status, doneAt: change.status === "done" ? now : null }
      : { day: change.day };
  const rows = await db
    .update(growthPlanTasksTable)
    .set(set)
    .where(and(eq(growthPlanTasksTable.profileId, profileId), eq(growthPlanTasksTable.id, taskId)))
    .returning({ id: growthPlanTasksTable.id });
  return rows.length > 0;
}

export async function getPlanTask(profileId: string, taskId: string) {
  const [row] = await db
    .select({ task: growthPlanTasksTable, weekStart: growthStrategiesTable.weekStart })
    .from(growthPlanTasksTable)
    .innerJoin(growthStrategiesTable, eq(growthStrategiesTable.id, growthPlanTasksTable.strategyId))
    .where(and(eq(growthPlanTasksTable.profileId, profileId), eq(growthPlanTasksTable.id, taskId)))
    .limit(1);
  return row;
}

/** How the previous plan went: the input for adapting the next one */
export async function getTaskCompletion(profileId: string, strategyId: string) {
  const [row] = await db
    .select({
      total: count(),
      done: sql<number>`count(*) filter (where ${growthPlanTasksTable.status} = 'done')::int`,
      skipped: sql<number>`count(*) filter (where ${growthPlanTasksTable.status} = 'skipped')::int`,
    })
    .from(growthPlanTasksTable)
    .where(and(eq(growthPlanTasksTable.profileId, profileId), eq(growthPlanTasksTable.strategyId, strategyId)));
  return { total: row?.total ?? 0, done: row?.done ?? 0, skipped: row?.skipped ?? 0 };
}

// ---- Experiments -----------------------------------------------------------------

export async function getExperiments(profileId: string): Promise<GrowthExperiment[]> {
  return db
    .select()
    .from(growthExperimentsTable)
    .where(eq(growthExperimentsTable.profileId, profileId))
    .orderBy(desc(growthExperimentsTable.createdAt))
    .limit(30);
}

export async function getExperiment(profileId: string, id: string): Promise<GrowthExperiment | undefined> {
  const [row] = await db
    .select()
    .from(growthExperimentsTable)
    .where(and(eq(growthExperimentsTable.profileId, profileId), eq(growthExperimentsTable.id, id)))
    .limit(1);
  return row;
}

export async function insertExperiment(profileId: string, values: ValidExperiment & { status: "proposed" | "active"; startedAt?: Date; endsAt?: Date }) {
  const [row] = await db.insert(growthExperimentsTable).values({ profileId, ...values }).returning();
  return row;
}

export async function countActiveExperiments(profileId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(growthExperimentsTable)
    .where(and(eq(growthExperimentsTable.profileId, profileId), eq(growthExperimentsTable.status, "active")));
  return row?.n ?? 0;
}

export async function updateExperiment(
  profileId: string,
  id: string,
  values: Partial<Pick<GrowthExperiment, "status" | "startedAt" | "endsAt" | "conclusion" | "durationDays">>,
): Promise<boolean> {
  const rows = await db
    .update(growthExperimentsTable)
    .set(values)
    .where(and(eq(growthExperimentsTable.profileId, profileId), eq(growthExperimentsTable.id, id)))
    .returning({ id: growthExperimentsTable.id });
  return rows.length > 0;
}

/** Appends one observation (kept to the 20 newest) */
export async function addExperimentObservation(profileId: string, id: string, observation: ExperimentObservation): Promise<boolean> {
  const rows = await db
    .update(growthExperimentsTable)
    .set({
      observations: sql`(
        select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) from (
          select item, ord from jsonb_array_elements(${growthExperimentsTable.observations} || ${JSON.stringify([observation])}::jsonb) with ordinality as t(item, ord)
          order by ord desc limit 20
        ) newest
      )`,
    })
    .where(and(eq(growthExperimentsTable.profileId, profileId), eq(growthExperimentsTable.id, id)))
    .returning({ id: growthExperimentsTable.id });
  return rows.length > 0;
}

export type { StrategyEvidence };
