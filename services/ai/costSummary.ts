import "server-only";

import { type AiCostRow, getAiCostByOperation, getRunAiCost } from "@/db/queries/aiUsage";
import { getRecentScoutRuns } from "@/db/queries/scoutRuns";
import type { AiOperation } from "@/db/schema";
import { AI_MODELS } from "@/lib/ai/client";

export const AI_OPERATION_LABELS: Record<AiOperation, string> = {
  opportunity_scoring: "Opportunity scoring",
  reply_generation: "Reply generation",
  brain_creation: "Brain creation",
  memory_learning: "Memory / learning",
  brain_eval: "Brain eval (dev)",
};

export type AiCostSummary = {
  allTime: AiCostRow[];
  last24h: AiCostRow[];
  totalUsd: number;
  last24hUsd: number;
  lastRun: { calls: number; costUsd: number; at: Date } | null;
  models: typeof AI_MODELS;
};

const total = (rows: AiCostRow[]) => rows.reduce((sum, row) => sum + row.costUsd, 0);

/** Estimated OpenAI spend for one user, per operation and for their last run. */
export async function getAiCostSummary(profileId: string): Promise<AiCostSummary> {
  const [allTime, last24h, runs] = await Promise.all([
    getAiCostByOperation(profileId),
    getAiCostByOperation(profileId, new Date(Date.now() - 24 * 3_600_000)),
    getRecentScoutRuns(profileId, 1),
  ]);
  const run = runs[0];
  const runCost = run ? await getRunAiCost(profileId, run.id) : null;

  return {
    allTime,
    last24h,
    totalUsd: total(allTime),
    last24hUsd: total(last24h),
    lastRun: run && runCost ? { ...runCost, at: run.createdAt } : null,
    models: AI_MODELS,
  };
}
