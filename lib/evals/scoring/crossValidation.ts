import "server-only";

import { AI_MODELS } from "@/lib/ai/client";
import { estimateCostUsd } from "@/lib/ai/pricing";
import {
  buildJudgmentRequest,
  type PreferenceExample,
  requestJudgments,
  type ScoringStage,
} from "@/services/opportunities/scoreOpportunity";
import { aiPoints } from "@/services/opportunities/scoringStrategy";

import { EvalBudgetError, outputCap, withEvalIsolation, worstCaseUsd } from "./runner";
import type { EvalDataset, EvalOutcome, EvalRun, OpportunityLabel, ReviewLabels } from "./types";

// Prompt v3 is personalized with the user's own ratings, so it can't be
// evaluated on the posts it learned from. Cross-validation: each profile's
// rated posts are split into folds; a fold is scored with examples taken only
// from the OTHER folds of the SAME profile. Every rated post is scored exactly
// once, by a prompt that has never seen it, and no profile's ratings ever
// reach another profile.

export const V3_STAGE: ScoringStage = {
  model: AI_MODELS.scoring,
  prompt: "v3",
  // One call per fold
  batchSize: 100,
};

export type Fold = { profileKey: string; index: number; evalIds: string[]; exampleIds: string[] };

/** Stratified folds per profile: each label spread over the folds. */
export function makeFolds(dataset: EvalDataset, labels: ReviewLabels, folds: number): Fold[] {
  const order: OpportunityLabel[] = ["strong", "acceptable", "weak", "irrelevant"];
  const result: Fold[] = [];
  for (const profileKey of Object.keys(dataset.profiles)) {
    const rated = dataset.examples
      .filter((example) => example.profileKey === profileKey && labels[example.id])
      .sort((a, b) => order.indexOf(labels[a.id].label) - order.indexOf(labels[b.id].label) || a.id.localeCompare(b.id));
    if (rated.length === 0) continue;
    const buckets: string[][] = Array.from({ length: folds }, () => []);
    rated.forEach((example, index) => buckets[index % folds].push(example.id));
    buckets.forEach((evalIds, index) => {
      if (evalIds.length === 0) return;
      const exampleIds = rated.map((example) => example.id).filter((id) => !evalIds.includes(id));
      result.push({ profileKey, index, evalIds, exampleIds });
    });
  }
  return result;
}

const MAX_EXAMPLE_CHARS = 400;

function toPreferenceExample(example: EvalDataset["examples"][number], label: OpportunityLabel): PreferenceExample {
  return {
    verdict: label,
    authorHandle: example.input.authorHandle,
    content: example.input.content.slice(0, MAX_EXAMPLE_CHARS),
    ...(example.input.quotedPost && { quotedPost: example.input.quotedPost.slice(0, MAX_EXAMPLE_CHARS) }),
  };
}

export async function runCrossValidatedV3(
  dataset: EvalDataset,
  labels: ReviewLabels,
  {
    folds = 2,
    mode = "mock",
    budgetUsd = null,
    outputTokensPerCandidate = 350,
  }: { folds?: number; mode?: "mock" | "live"; budgetUsd?: number | null; outputTokensPerCandidate?: number } = {},
): Promise<EvalRun & { folds: Fold[] }> {
  if (mode === "live" && !(budgetUsd && budgetUsd > 0)) {
    throw new EvalBudgetError("A live evaluation needs a positive budget (USD).");
  }
  const byId = new Map(dataset.examples.map((example) => [example.id, example]));
  const plan = makeFolds(dataset, labels, folds);
  const run: EvalRun & { folds: Fold[] } = {
    strategy: `v3-cv${folds}`,
    mode,
    startedAt: new Date().toISOString(),
    examples: plan.reduce((sum, fold) => sum + fold.evalIds.length, 0),
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
    folds: plan,
  };

  await withEvalIsolation(mode, async () => {
    // One fold at a time: every call's worst case is checked against what is left
    for (const fold of plan) {
      const profile = dataset.profiles[fold.profileKey];
      const candidates = fold.evalIds.map((id) => byId.get(id)!.input);
      const preferenceExamples = fold.exampleIds.map((id) => toPreferenceExample(byId.get(id)!, labels[id].label));
      const request = buildJudgmentRequest(V3_STAGE, profile.brain, candidates, { preferenceExamples });
      run.calls++;

      let judgments = new Map<string, import("@/lib/ai/schemas/opportunity").CandidateJudgment>();
      if (mode === "live") {
        const maxOutputTokens = outputCap(candidates.length, outputTokensPerCandidate);
        const worst = worstCaseUsd(V3_STAGE, request, maxOutputTokens);
        if (run.costUsd + worst > (budgetUsd ?? 0)) {
          run.stoppedByBudget = true;
          run.failedCalls++;
          run.errors.push(`fold ${fold.profileKey}#${fold.index}: budget reached; call not made`);
          continue;
        }
        try {
          const response = await requestJudgments(V3_STAGE, profile.brain, candidates, {
            preferenceExamples,
            maxOutputTokens,
            maxRetries: 0,
          });
          const usage = response.usage;
          if (usage) {
            const tokens = {
              inputTokens: usage.input_tokens,
              cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
              outputTokens: usage.output_tokens,
            };
            const cost = estimateCostUsd(response.model, tokens) ?? worst;
            run.costUsd += cost;
            run.costByModel[response.model] = (run.costByModel[response.model] ?? 0) + cost;
            run.tokens.input += tokens.inputTokens;
            run.tokens.cachedInput += tokens.cachedInputTokens;
            run.tokens.output += tokens.outputTokens;
            run.tokens.reasoning += usage.output_tokens_details?.reasoning_tokens ?? 0;
          }
          run.latencyMs += response.latencyMs;
          if (!response.parsed) {
            run.invalidOutputs++;
            run.failedCalls++;
          }
          judgments = response.judgments;
          run.missingJudgments += candidates.length - judgments.size;
        } catch (error) {
          // Sent but failed: usage unknown, so the reserved worst case counts
          run.costUsd += worst;
          run.unaccountedUsd += worst;
          run.failedCalls++;
          run.errors.push(error instanceof Error ? error.message : String(error));
        }
      }

      for (const id of fold.evalIds) {
        const example = byId.get(id)!;
        const judgment = judgments.get(id);
        const score = judgment ? Math.min(100, aiPoints(judgment) + example.freshness) : null;
        const outcome: EvalOutcome = {
          id,
          score,
          shouldEngage: judgment?.shouldEngage ?? null,
          surfaced: Boolean(judgment?.shouldEngage && score !== null && score >= profile.threshold),
          reason: judgment?.reason ?? null,
          suggestedAngle: judgment?.suggestedAngle ?? null,
          topic: judgment?.topic ?? null,
          stage: judgment ? "primary" : null,
          prefiltered: null,
        };
        run.outcomes.push(outcome);
      }
    }
  });
  return run;
}
