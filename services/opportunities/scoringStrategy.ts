import { AI_MODELS } from "@/lib/ai/client";
import type { CandidateJudgment } from "@/lib/ai/schemas/opportunity";
import {
  prefilterCandidates,
  type PrefilterReason,
} from "@/lib/scout/prefilter";
import { mapSettled } from "@/services/scout/concurrency";

import {
  BASELINE_STAGE,
  type CandidateForJudgment,
  type JudgmentResponse,
  productionScoringStage,
  type ScoringStage,
} from "./scoreOpportunity";

// Day 20: how candidates are scored is a strategy, chosen by configuration.
// "baseline" is production since Day 9 and the default; the others exist to
// be evaluated (lib/evals/scoring) before anyone turns them on.
//
//   SCOUT_SCORING_STRATEGY=baseline | optimized | cheap | hybrid
//
// Rollback is setting it back to baseline (or removing it).

export const SCORING_STRATEGY_IDS = [
  "baseline",
  "optimized",
  "cheap",
  "hybrid",
] as const;
export type ScoringStrategyId = (typeof SCORING_STRATEGY_IDS)[number];

export type ScoringStrategy = {
  id: ScoringStrategyId;
  primary: ScoringStage;
  /**
   * Hybrid: candidates the primary stage finds promising (shouldEngage, or
   * within `margin` points of the user's threshold) are judged again here,
   * and this judgment is the one kept.
   */
  escalation: { stage: ScoringStage; margin: number } | null;
  /** The deterministic pre-filter (lib/scout/prefilter.ts) runs first */
  prefilter: boolean;
};

/** gpt-5.5 with prompt v2 (output budget), low reasoning effort, bigger batches */
const OPTIMIZED_STAGE: ScoringStage = {
  model: AI_MODELS.scoring,
  prompt: "v2",
  reasoningEffort: "low",
  verbosity: "low",
  batchSize: 15,
};

/** A smaller model with the same prompt; OPENAI_SCORING_CHEAP_MODEL overrides it */
const CHEAP_STAGE: ScoringStage = {
  ...OPTIMIZED_STAGE,
  model: process.env.OPENAI_SCORING_CHEAP_MODEL ?? "gpt-5.4-mini",
};

export const SCORING_STRATEGIES: Record<ScoringStrategyId, ScoringStrategy> = {
  baseline: {
    id: "baseline",
    primary: BASELINE_STAGE,
    escalation: null,
    prefilter: false,
  },
  optimized: {
    id: "optimized",
    primary: OPTIMIZED_STAGE,
    escalation: null,
    prefilter: true,
  },
  cheap: {
    id: "cheap",
    primary: CHEAP_STAGE,
    escalation: null,
    prefilter: true,
  },
  hybrid: {
    id: "hybrid",
    primary: CHEAP_STAGE,
    escalation: { stage: OPTIMIZED_STAGE, margin: 15 },
    prefilter: true,
  },
};

/** The configured strategy; anything unknown falls back to baseline. */
export function getScoringStrategy(
  id = process.env.SCOUT_SCORING_STRATEGY,
): ScoringStrategy {
  // Baseline runs with the production effort setting (read per call, so the
  // env var rolls it back without a deploy of new code)
  const baseline = { ...SCORING_STRATEGIES.baseline, primary: productionScoringStage() };
  if (!id || id === "baseline") return baseline;
  if ((SCORING_STRATEGY_IDS as readonly string[]).includes(id)) {
    return SCORING_STRATEGIES[id as ScoringStrategyId];
  }
  console.warn(`Unknown SCOUT_SCORING_STRATEGY "${id}"; using baseline.`);
  return baseline;
}

/** Judges one batch with one stage; production records usage, evaluation doesn't. */
export type Judge = (
  stage: ScoringStage,
  batch: CandidateForJudgment[],
) => Promise<JudgmentResponse>;

export type StrategyResult = {
  judgments: Map<string, CandidateJudgment>;
  /** Which stage produced each kept judgment */
  stageOf: Map<string, "primary" | "escalation">;
  prefiltered: { id: string; reason: PrefilterReason }[];
  calls: number;
  failedCalls: number;
  escalated: number;
  /** Summed over calls (calls run two at a time) */
  latencyMs: number;
  models: string[];
  /** Reasoning efforts the successful calls actually sent ("default": none sent) */
  reasoningEfforts: string[];
  errors: string[];
};

/** Parallel model calls per stage, as before Day 20 */
const CONCURRENCY = 2;

/** Points from the model's factors alone (0–85), before freshness and learning. */
export function aiPoints(judgment: CandidateJudgment): number {
  const clamp = (value: number, max: number) =>
    Math.min(max, Math.max(0, Math.round(value)));
  return (
    clamp(judgment.relevance, 25) +
    clamp(judgment.goalAlignment, 20) +
    clamp(judgment.expertiseFit, 20) +
    clamp(judgment.audienceValue, 10) +
    clamp(judgment.novelty, 10)
  );
}

/**
 * Scores candidates with a strategy. A candidate missing from `judgments`
 * (failed batch, skipped by the model, failed escalation) stays unscored and
 * is retried on the next run, exactly like before Day 20.
 */
export async function scoreWithStrategy(
  strategy: ScoringStrategy,
  candidates: CandidateForJudgment[],
  {
    judge,
    freshness,
    threshold,
    userWriting,
  }: {
    judge: Judge;
    /** Freshness points per candidate id (code, not AI) */
    freshness: Map<string, number>;
    /** The user's surface threshold; hybrid escalates near it */
    threshold: number;
    userWriting: string[];
  },
): Promise<StrategyResult> {
  const result: StrategyResult = {
    judgments: new Map(),
    stageOf: new Map(),
    prefiltered: [],
    calls: 0,
    failedCalls: 0,
    escalated: 0,
    latencyMs: 0,
    models: [],
    reasoningEfforts: [],
    errors: [],
  };

  let toScore = candidates;
  if (strategy.prefilter) {
    const { keep, rejected } = prefilterCandidates(candidates, { userWriting });
    toScore = keep;
    result.prefiltered = rejected.map(({ candidate, reason }) => ({
      id: candidate.candidateId,
      reason,
    }));
  }

  const runStage = async (
    stage: ScoringStage,
    items: CandidateForJudgment[],
  ) => {
    const batches: CandidateForJudgment[][] = [];
    for (let i = 0; i < items.length; i += stage.batchSize)
      batches.push(items.slice(i, i + stage.batchSize));
    const settled = await mapSettled(batches, CONCURRENCY, (batch) =>
      judge(stage, batch),
    );
    const judgments = new Map<string, CandidateJudgment>();
    for (const outcome of settled) {
      result.calls++;
      if (outcome.status === "rejected") {
        result.failedCalls++;
        result.errors.push(
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        );
        continue;
      }
      result.latencyMs += outcome.value.latencyMs;
      if (!result.models.includes(outcome.value.model))
        result.models.push(outcome.value.model);
      if (!result.reasoningEfforts.includes(outcome.value.reasoningEffort))
        result.reasoningEfforts.push(outcome.value.reasoningEffort);
      for (const [id, judgment] of outcome.value.judgments)
        judgments.set(id, judgment);
    }
    return judgments;
  };

  const primary = await runStage(strategy.primary, toScore);
  for (const [id, judgment] of primary) {
    result.judgments.set(id, judgment);
    result.stageOf.set(id, "primary");
  }
  if (!strategy.escalation) return result;

  const { stage, margin } = strategy.escalation;
  const promising = toScore.filter((candidate) => {
    const judgment = primary.get(candidate.candidateId);
    if (!judgment) return false;
    const total =
      aiPoints(judgment) + (freshness.get(candidate.candidateId) ?? 0);
    return judgment.shouldEngage || total >= threshold - margin;
  });
  result.escalated = promising.length;
  if (promising.length === 0) return result;

  const second = await runStage(stage, promising);
  for (const candidate of promising) {
    const judgment = second.get(candidate.candidateId);
    if (judgment) {
      result.judgments.set(candidate.candidateId, judgment);
      result.stageOf.set(candidate.candidateId, "escalation");
    } else {
      // The cheap verdict alone may not surface a promising post: retry next run
      result.judgments.delete(candidate.candidateId);
      result.stageOf.delete(candidate.candidateId);
    }
  }
  return result;
}
