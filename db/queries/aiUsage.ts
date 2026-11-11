import "server-only";

import { and, desc, eq, gte, sql, sum } from "drizzle-orm";

import db from "@/db";
import { type AiOperation, aiUsageTable } from "@/db/schema";

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

/** Estimated AI cost of one Scout run (its opportunity scoring). */
export async function getRunAiCost(
  profileId: string,
  scoutRunId: string,
): Promise<{ calls: number; costUsd: number }> {
  const [row] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      costUsd: sql<number>`coalesce(sum(${aiUsageTable.costUsd}), 0)::float8`,
    })
    .from(aiUsageTable)
    .where(and(eq(aiUsageTable.profileId, profileId), eq(aiUsageTable.scoutRunId, scoutRunId)));
  return row;
}
