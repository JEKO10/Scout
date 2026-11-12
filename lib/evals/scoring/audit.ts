import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import db from "@/db";
import { aiUsageTable, scoutRunsTable } from "@/db/schema";
import { pricingFor } from "@/lib/ai/pricing";

// Step 1 of Day 20: where scoring money goes, from the usage OpenAI actually
// reported (ai_usage). SELECTs only.

export type ScoringAudit = {
  runs: number;
  calls: number;
  candidates: number;
  tokens: {
    input: number;
    cachedInput: number;
    output: number;
    reasoning: number;
  };
  perCandidate: {
    input: number;
    output: number;
    reasoning: number;
    visibleOutput: number;
  };
  perCall: { input: number; output: number; candidates: number };
  costUsd: number;
  costPerCandidate: number;
  /** Shares of cost: uncached input, cached input, visible output, reasoning */
  costShare: {
    input: number;
    cachedInput: number;
    visibleOutput: number;
    reasoning: number;
  };
  cacheHitRate: number;
  models: string[];
};

export async function auditScoringCost(): Promise<ScoringAudit> {
  const usage = await db
    .select()
    .from(aiUsageTable)
    .where(eq(aiUsageTable.operation, "opportunity_scoring"));
  const runIds = [
    ...new Set(
      usage
        .map((row) => row.scoutRunId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const runs = runIds.length
    ? await db
        .select({ id: scoutRunsTable.id, stats: scoutRunsTable.stats })
        .from(scoutRunsTable)
        .where(and(inArray(scoutRunsTable.id, runIds)))
    : [];
  const candidates = runs.reduce(
    (sum, run) => sum + (run.stats?.scoring?.scored ?? 0),
    0,
  );

  const tokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  const cost = { input: 0, cachedInput: 0, visibleOutput: 0, reasoning: 0 };
  for (const row of usage) {
    tokens.input += row.inputTokens;
    tokens.cachedInput += row.cachedInputTokens;
    tokens.output += row.outputTokens;
    tokens.reasoning += row.reasoningTokens;
    const price = pricingFor(row.model);
    if (!price) continue;
    cost.input +=
      ((row.inputTokens - row.cachedInputTokens) * price.input) / 1e6;
    cost.cachedInput += (row.cachedInputTokens * price.cachedInput) / 1e6;
    cost.visibleOutput +=
      ((row.outputTokens - row.reasoningTokens) * price.output) / 1e6;
    cost.reasoning += (row.reasoningTokens * price.output) / 1e6;
  }
  const total =
    cost.input + cost.cachedInput + cost.visibleOutput + cost.reasoning;
  const per = (value: number) => (candidates ? value / candidates : 0);
  const share = (value: number) => (total ? value / total : 0);
  return {
    runs: runs.length,
    calls: usage.length,
    candidates,
    tokens,
    perCandidate: {
      input: per(tokens.input),
      output: per(tokens.output),
      reasoning: per(tokens.reasoning),
      visibleOutput: per(tokens.output - tokens.reasoning),
    },
    perCall: {
      input: usage.length ? tokens.input / usage.length : 0,
      output: usage.length ? tokens.output / usage.length : 0,
      candidates: usage.length ? candidates / usage.length : 0,
    },
    costUsd: total,
    costPerCandidate: per(total),
    costShare: {
      input: share(cost.input),
      cachedInput: share(cost.cachedInput),
      visibleOutput: share(cost.visibleOutput),
      reasoning: share(cost.reasoning),
    },
    cacheHitRate: tokens.input ? tokens.cachedInput / tokens.input : 0,
    models: [...new Set(usage.map((row) => row.model))],
  };
}
