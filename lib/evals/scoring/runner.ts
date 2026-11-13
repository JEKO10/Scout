import "server-only";

import { createHash } from "node:crypto";

import { estimateCostUsd, pricingFor } from "@/lib/ai/pricing";
import type { CandidateJudgment } from "@/lib/ai/schemas/opportunity";
import {
  buildJudgmentRequest,
  type CandidateForJudgment,
  type JudgmentResponse,
  requestJudgments,
  type ScoringStage,
} from "@/services/opportunities/scoreOpportunity";
import {
  aiPoints,
  getScoringStrategy,
  type Judge,
  scoreWithStrategy,
  type ScoringStrategyId,
} from "@/services/opportunities/scoringStrategy";

import type { EvalDataset, EvalOutcome, EvalRun } from "./types";
import { EVAL_VARIANTS, type EvalVariantId, isEvalVariant } from "./variants";

// Runs a scoring strategy over the evaluation dataset, isolated from the app:
// no database (the dataset is a file), no X, no Slack, no usage rows, no
// opportunities. "mock" (the default) simulates the model and costs nothing;
// "live" calls OpenAI and needs an explicit budget.

/** Hosts an evaluation may reach: OpenAI, and only in live mode */
export const EVAL_ALLOWED_HOSTS = {
  mock: [] as string[],
  live: ["api.openai.com"],
};

export class EvalIsolationError extends Error {}
export class EvalBudgetError extends Error {}

/**
 * Runs `task` with global fetch restricted to the allowed hosts: a bug that
 * reached X, Slack or the database would fail the evaluation, not do the call.
 */
export async function withEvalIsolation<T>(
  mode: "mock" | "live",
  task: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const allowed = EVAL_ALLOWED_HOSTS[mode];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (!allowed.includes(url.hostname)) {
      throw new EvalIsolationError(
        `Evaluation blocked a request to ${url.hostname}`,
      );
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    return await task();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Assumptions for mock mode. Input tokens come from the real request text;
 * output per candidate is measured for prompt v1 (production ai_usage,
 * Nov 2026: ~125 visible + ~113 reasoning tokens) and assumed for v2.
 */
export const MOCK_ASSUMPTIONS = {
  /** Calibrated: v1 requests of the dataset vs input tokens OpenAI reported (479 per candidate) */
  charsPerToken: 3.9,
  outputTokensPerCandidate: { v1: 125, v2: 70, v3: 125 },
  reasoningTokensPerCandidate: {
    default: 113,
    low: 30,
    none: 0,
    minimal: 10,
    medium: 113,
    high: 250,
    xhigh: 400,
    max: 600,
  },
  latencyMsPerOutputToken: 12,
};

function hashUnit(text: string): number {
  return (
    createHash("sha256").update(text).digest().readUInt32BE(0) / 0xffffffff
  );
}

/**
 * Mock model: the original verdict with deterministic noise per model, so the
 * pipeline (batching, escalation, metrics, budgets) runs end to end. Its
 * "quality" means nothing; only live runs measure quality.
 */
export function mockJudgment(
  stage: ScoringStage,
  candidate: CandidateForJudgment,
  original: EvalDatasetExampleOriginal | undefined,
): CandidateJudgment {
  const noise =
    stage.model.includes("mini") || stage.model.includes("nano") ? 8 : 3;
  const jitter = (field: string, value: number, max: number) => {
    const delta = Math.round(
      (hashUnit(`${stage.model}:${candidate.candidateId}:${field}`) * 2 - 1) *
        noise *
        (max / 25),
    );
    return Math.min(max, Math.max(0, value + delta));
  };
  const b = original?.breakdown;
  return {
    candidateId: candidate.candidateId,
    relevance: jitter("relevance", b?.relevance ?? 5, 25),
    goalAlignment: jitter("goalAlignment", b?.goalAlignment ?? 4, 20),
    expertiseFit: jitter("expertiseFit", b?.expertiseFit ?? 4, 20),
    audienceValue: jitter("audienceValue", b?.audienceValue ?? 2, 10),
    novelty: jitter("novelty", b?.novelty ?? 2, 10),
    shouldEngage: original?.shouldEngage ?? false,
    reason: "(mock) simulated reason",
    topic: original?.topic ?? "Mock",
    suggestedAngle: original?.shouldEngage ? "(mock) simulated angle" : "",
  };
}

type EvalDatasetExampleOriginal = EvalDataset["examples"][number]["original"];

function mockJudge(dataset: EvalDataset, profileKey: string): Judge {
  const originals = new Map(
    dataset.examples.map((example) => [example.id, example.original]),
  );
  return async (stage, batch) => {
    const request = buildJudgmentRequest(
      stage,
      dataset.profiles[profileKey].brain,
      batch,
    );
    // The structured-output schema is input too
    const chars =
      request.instructions.length +
      request.input.length +
      JSON.stringify(request.text.format).length;
    const inputTokens = Math.ceil(chars / MOCK_ASSUMPTIONS.charsPerToken);
    const visible =
      MOCK_ASSUMPTIONS.outputTokensPerCandidate[stage.prompt] * batch.length;
    const reasoning =
      MOCK_ASSUMPTIONS.reasoningTokensPerCandidate[
        stage.reasoningEffort ?? "default"
      ] * batch.length;
    return {
      judgments: new Map(
        batch.map((c) => [
          c.candidateId,
          mockJudgment(stage, c, originals.get(c.candidateId)),
        ]),
      ),
      parsed: true,
      unknownIds: 0,
      model: stage.model,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: visible + reasoning,
        output_tokens_details: { reasoning_tokens: reasoning },
        total_tokens: inputTokens + visible + reasoning,
      },
      latencyMs:
        (visible + reasoning) * MOCK_ASSUMPTIONS.latencyMsPerOutputToken,
      reasoningEffort: stage.reasoningEffort ?? "default",
    } satisfies JudgmentResponse;
  };
}

/**
 * Live calls get a hard output cap, so a call can never cost more than the
 * amount reserved for it. Production uses ~240 output tokens per candidate.
 */
export function outputCap(batch: number, perCandidate = 600): number {
  return 400 + perCandidate * batch;
}

/**
 * Upper bound for one call, reserved against the budget before it is made:
 * input counted at 2 characters per token (real text averages ~3.9), output
 * at its hard cap, nothing cached.
 */
export function worstCaseUsd(
  stage: ScoringStage,
  request: { instructions: string; input: string; text: unknown },
  maxOutputTokens: number,
) {
  const price = pricingFor(stage.model);
  if (!price) {
    throw new EvalBudgetError(`No price configured for ${stage.model}; add it to lib/ai/pricing.ts.`);
  }
  const chars = request.instructions.length + request.input.length + JSON.stringify(request.text).length;
  return ((chars / 2) * price.input + maxOutputTokens * price.output) / 1_000_000;
}

export async function runScoringEval(
  dataset: EvalDataset,
  strategyId: ScoringStrategyId | EvalVariantId,
  {
    mode = "mock",
    budgetUsd = null,
    exampleIds,
    outputTokensPerCandidate = 600,
  }: {
    mode?: "mock" | "live";
    budgetUsd?: number | null;
    exampleIds?: string[];
    /** Hard output cap per candidate in live calls (and the budget's worst case) */
    outputTokensPerCandidate?: number;
  } = {},
): Promise<EvalRun> {
  if (mode === "live" && !(budgetUsd && budgetUsd > 0)) {
    throw new EvalBudgetError(
      "A live evaluation needs a positive budget (USD).",
    );
  }
  // Evaluation-only variants are resolved here, never through the production flag
  const strategy = isEvalVariant(strategyId) ? EVAL_VARIANTS[strategyId] : getScoringStrategy(strategyId);
  const examples = exampleIds
    ? dataset.examples.filter((example) => exampleIds.includes(example.id))
    : dataset.examples;

  const run: EvalRun = {
    strategy: strategyId,
    mode,
    startedAt: new Date().toISOString(),
    examples: examples.length,
    outcomes: [],
    calls: 0,
    failedCalls: 0,
    invalidOutputs: 0,
    missingJudgments: 0,
    escalated: 0,
    latencyMs: 0,
    tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
    costUsd: 0,
    unaccountedUsd: 0,
    costByModel: {},
    budgetUsd,
    stoppedByBudget: false,
    errors: [],
  };
  let reserved = 0;

  await withEvalIsolation(mode, async () => {
    for (const profileKey of Object.keys(dataset.profiles)) {
      const profile = dataset.profiles[profileKey];
      const own = examples.filter(
        (example) => example.profileKey === profileKey,
      );
      if (own.length === 0) continue;

      const inner = mode === "mock" ? mockJudge(dataset, profileKey) : null;
      // Counts every call and its cost; live calls are checked against the budget first
      const judge: Judge = async (stage, batch) => {
        let worst = 0;
        if (mode === "live") {
          worst = worstCaseUsd(
            stage,
            buildJudgmentRequest(stage, profile.brain, batch),
            outputCap(batch.length, outputTokensPerCandidate),
          );
          if (run.costUsd + reserved + worst > (budgetUsd ?? 0)) {
            run.stoppedByBudget = true;
            throw new EvalBudgetError("Budget reached; call not made.");
          }
          reserved += worst;
        }
        try {
          let response: JudgmentResponse;
          try {
            response = inner
              ? await inner(stage, batch)
              : await requestJudgments(stage, profile.brain, batch, {
                  cacheKey: `eval:${profileKey}`,
                  maxOutputTokens: outputCap(batch.length, outputTokensPerCandidate),
                  maxRetries: 0,
                });
          } catch (error) {
            // Failed after sending (e.g. output that doesn't parse): OpenAI may
            // still bill it, and its usage is unknown. Count the reserved worst case.
            if (mode === "live") {
              run.costUsd += worst;
              run.unaccountedUsd += worst;
            }
            throw error;
          }
          const usage = response.usage;
          if (usage) {
            const tokens = {
              inputTokens: usage.input_tokens,
              cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
              outputTokens: usage.output_tokens,
            };
            const cost = estimateCostUsd(response.model, tokens) ?? 0;
            run.costUsd += cost;
            run.costByModel[response.model] =
              (run.costByModel[response.model] ?? 0) + cost;
            run.tokens.input += tokens.inputTokens;
            run.tokens.cachedInput += tokens.cachedInputTokens;
            run.tokens.output += tokens.outputTokens;
            run.tokens.reasoning +=
              usage.output_tokens_details?.reasoning_tokens ?? 0;
          }
          if (!response.parsed) {
            run.invalidOutputs++;
            throw new Error("Output did not match the schema.");
          }
          run.missingJudgments += batch.length - response.judgments.size;
          return response;
        } finally {
          reserved -= worst;
        }
      };

      const result = await scoreWithStrategy(
        strategy,
        own.map((example) => example.input),
        {
          judge,
          freshness: new Map(
            own.map((example) => [example.id, example.freshness]),
          ),
          threshold: profile.threshold,
          userWriting: profile.userWriting,
        },
      );
      run.calls += result.calls;
      run.failedCalls += result.failedCalls;
      run.escalated += result.escalated;
      run.latencyMs += result.latencyMs;
      run.errors.push(...result.errors);

      const prefiltered = new Map(
        result.prefiltered.map((item) => [item.id, item.reason]),
      );
      for (const example of own) {
        const judgment = result.judgments.get(example.id);
        const score = judgment
          ? Math.min(100, aiPoints(judgment) + example.freshness)
          : null;
        const outcome: EvalOutcome = {
          id: example.id,
          score,
          shouldEngage: judgment?.shouldEngage ?? null,
          surfaced: Boolean(
            judgment?.shouldEngage &&
            score !== null &&
            score >= profile.threshold,
          ),
          reason: judgment?.reason ?? null,
          suggestedAngle: judgment?.suggestedAngle ?? null,
          topic: judgment?.topic ?? null,
          stage: result.stageOf.get(example.id) ?? null,
          prefiltered: prefiltered.get(example.id) ?? null,
        };
        run.outcomes.push(outcome);
      }
    }
  });
  return run;
}

/**
 * Several strategies under one shared budget: each run may only use what the
 * runs before it left, so the total can never pass `totalBudgetUsd`.
 */
export async function runScoringEvals(
  dataset: EvalDataset,
  strategies: ScoringStrategyId[],
  {
    totalBudgetUsd,
    onRun,
  }: { totalBudgetUsd: number; onRun?: (run: EvalRun, spentUsd: number) => void },
): Promise<{ runs: EvalRun[]; spentUsd: number; skipped: ScoringStrategyId[] }> {
  if (!(totalBudgetUsd > 0)) throw new EvalBudgetError("A live evaluation needs a positive budget (USD).");
  const runs: EvalRun[] = [];
  const skipped: ScoringStrategyId[] = [];
  let spentUsd = 0;
  for (const strategy of strategies) {
    const remaining = totalBudgetUsd - spentUsd;
    if (remaining <= 0) {
      skipped.push(strategy);
      continue;
    }
    const run = await runScoringEval(dataset, strategy, { mode: "live", budgetUsd: remaining });
    spentUsd += run.costUsd;
    runs.push(run);
    onRun?.(run, spentUsd);
  }
  return { runs, spentUsd, skipped };
}
