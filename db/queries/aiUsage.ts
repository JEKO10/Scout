import "server-only";

import { and, desc, eq, gte, inArray, sql, sum } from "drizzle-orm";

import db from "@/db";
import { type AiOperation, aiUsageTable, scoutRunsTable } from "@/db/schema";

export async function insertAiUsage(values: typeof aiUsageTable.$inferInsert): Promise<void> {
  await db.insert(aiUsageTable).values(values);
}

export type AiCostRow = {
  operation: AiOperation;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Calls whose model had no configured price, so costUsd leaves them out */
  unpriced: number;
};

/** Totals per operation for one profile, optionally since a moment. */
export async function getAiCostByOperation(
  profileId: string,
  since?: Date,
): Promise<AiCostRow[]> {
  const rows = await db
    .select({
      operation: aiUsageTable.operation,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageTable.inputTokens}), 0)::int`,
      cachedInputTokens: sql<number>`coalesce(sum(${aiUsageTable.cachedInputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageTable.outputTokens}), 0)::int`,
      reasoningTokens: sql<number>`coalesce(sum(${aiUsageTable.reasoningTokens}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${aiUsageTable.costUsd}), 0)::float8`,
      unpriced: sql<number>`count(*) filter (where ${aiUsageTable.costUsd} is null)::int`,
    })
    .from(aiUsageTable)
    .where(
      and(
        eq(aiUsageTable.profileId, profileId),
        since ? gte(aiUsageTable.createdAt, since) : undefined,
      ),
    )
    .groupBy(aiUsageTable.operation)
    .orderBy(desc(sum(aiUsageTable.costUsd)));
  return rows;
}

export type RunAiCost = {
  calls: number;
  /** Scoring during the run plus replies generated later for its opportunities */
  costUsd: number;
  scoringUsd: number;
  replyUsd: number;
};

/** Estimated AI cost of one Scout run. */
export async function getRunAiCost(profileId: string, scoutRunId: string): Promise<RunAiCost> {
  return (await getRunsAiCost(profileId, [scoutRunId])).get(scoutRunId) ?? emptyRunCost;
}

const emptyRunCost: RunAiCost = { calls: 0, costUsd: 0, scoringUsd: 0, replyUsd: 0 };

/** Estimated AI cost per run, for several runs at once. */
export async function getRunsAiCost(
  profileId: string,
  scoutRunIds: string[],
): Promise<Map<string, RunAiCost>> {
  if (scoutRunIds.length === 0) return new Map();
  const rows = await db
    .select({
      scoutRunId: aiUsageTable.scoutRunId,
      calls: sql<number>`count(*)::int`,
      costUsd: sql<number>`coalesce(sum(${aiUsageTable.costUsd}), 0)::float8`,
      scoringUsd: sql<number>`coalesce(sum(${aiUsageTable.costUsd}) filter (where ${aiUsageTable.operation} = 'opportunity_scoring'), 0)::float8`,
      replyUsd: sql<number>`coalesce(sum(${aiUsageTable.costUsd}) filter (where ${aiUsageTable.operation} = 'reply_generation'), 0)::float8`,
    })
    .from(aiUsageTable)
    .where(
      and(eq(aiUsageTable.profileId, profileId), inArray(aiUsageTable.scoutRunId, scoutRunIds)),
    )
    .groupBy(aiUsageTable.scoutRunId);
  return new Map(rows.map(({ scoutRunId, ...cost }) => [scoutRunId!, cost]));
}

/**
 * Average scoring cost per candidate in the profile's recent runs, from the
 * runs' scored counts and their recorded scoring cost. Null without data.
 */
export async function getScoringCostPerCandidate(
  profileId: string,
  since: Date,
): Promise<number | null> {
  const result = await db.execute<{ cost: number; scored: number }>(sql`
    select
      coalesce(sum(u.cost), 0)::float8 as cost,
      coalesce(sum((r."stats" -> 'scoring' ->> 'scored')::int), 0)::int as scored
    from ${scoutRunsTable} r
    join (
      select "scoutRunId", sum("costUsd") as cost
      from ${aiUsageTable}
      where "operation" = 'opportunity_scoring' and "costUsd" is not null
      group by "scoutRunId"
    ) u on u."scoutRunId" = r."id"
    where r."profileId" = ${profileId}::uuid and r."createdAt" >= ${since.toISOString()}::timestamptz
  `);
  const row = result.rows[0];
  return row && row.scored > 0 ? Number(row.cost) / Number(row.scored) : null;
}
