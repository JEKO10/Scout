import "server-only";

import { createHash } from "node:crypto";

import { AI_MODELS } from "@/lib/ai/client";
import { estimateCostUsd, pricingFor } from "@/lib/ai/pricing";
import type { CandidateJudgment } from "@/lib/ai/schemas/opportunity";
import {
  buildJudgmentRequest,
  requestJudgments,
  type ScoringStage,
} from "@/services/opportunities/scoreOpportunity";
import { aiPoints } from "@/services/opportunities/scoringStrategy";

import { MOCK_ASSUMPTIONS, mockJudgment, outputCap, withEvalIsolation, worstCaseUsd } from "./runner";
import type { EvalDataset, OpportunityLabel, ReviewLabels } from "./types";

// Scoring stability (Day 21): the same production prompt (v1) on the same
// cached posts, again and again, varying one thing at a time: nothing
// (repeats), the order inside a batch, the neighbouring posts, batch vs one
// post per call, and reasoning effort. Only the posts a human rated are used,
// so every trial is also scored against the labels. Nothing touches the app.

export type Trial = {
  name: string;
  kind: "repeat" | "shuffle" | "regroup" | "single" | "effort";
  effort?: "low" | "medium" | "high";
  /** Ordered batches of example ids, each within one profile */
  batches: string[][];
};

const BATCH = 10;

function hash(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}:${id}`).digest("hex");
}
const shuffled = (ids: string[], seed: string) => [...ids].sort((a, b) => hash(seed, a).localeCompare(hash(seed, b)));
const chunk = (ids: string[], size: number) =>
  Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => ids.slice(i * size, i * size + size));

/** low-repeat: low effort twice more, to measure its own noise (with the earlier effort-low run) */
export type StabilityPlan = "minimal" | "full" | "low-repeat";

export function buildTrials(dataset: EvalDataset, labels: ReviewLabels, plan: StabilityPlan): Trial[] {
  const byProfile = Object.keys(dataset.profiles).map((key) =>
    dataset.examples.filter((e) => e.profileKey === key && labels[e.id]).map((e) => e.id),
  );
  // The fixed batches every repeat uses: same posts, same order
  const fixed = byProfile.flatMap((ids) => chunk(shuffled(ids, "fixed"), BATCH));
  const reorder = (seed: string) => fixed.map((batch) => shuffled(batch, seed));
  const regroup = (seed: string) => byProfile.flatMap((ids) => chunk(shuffled(ids, seed), BATCH));
  // One post per call costs ~2.5x per post (the prompt prefix isn't shared):
  // the minimal plan does it for 10 posts per profile
  const singles = byProfile.flatMap((ids) =>
    (plan === "full" ? ids : shuffled(ids, "single").slice(0, 10)).map((id) => [id]),
  );

  if (plan === "low-repeat") {
    // "repeat" kind: the report then measures low effort's own noise
    return [2, 3].map((n) => ({ name: `effort-low-${n}`, kind: "repeat" as const, effort: "low" as const, batches: fixed }));
  }
  const repeats = plan === "full" ? 3 : 2;
  const trials: Trial[] = Array.from({ length: repeats }, (_, i) => ({ name: `repeat-${i + 1}`, kind: "repeat" as const, batches: fixed }));
  trials.push({ name: "shuffle-1", kind: "shuffle", batches: reorder("order-1") });
  if (plan === "full") trials.push({ name: "shuffle-2", kind: "shuffle", batches: reorder("order-2") });
  // Minimal: the earlier 160-post baseline run already scored these posts in
  // other batches, so it serves as the free "different neighbours" trial
  if (plan === "full") trials.push({ name: "regroup-1", kind: "regroup", batches: regroup("group-1") });
  if (plan === "full") trials.push({ name: "regroup-2", kind: "regroup", batches: regroup("group-2") });
  trials.push({ name: "single", kind: "single", batches: singles });
  trials.push({ name: "effort-low", kind: "effort", effort: "low", batches: fixed });
  if (plan === "full") trials.push({ name: "effort-high", kind: "effort", effort: "high", batches: fixed });
  return trials;
}

function stageFor(trial: Trial): ScoringStage {
  return {
    model: AI_MODELS.scoring,
    prompt: "v1",
    batchSize: BATCH,
    // Default (medium) is the production request: no reasoning parameter
    ...(trial.effort && trial.effort !== "medium" && { reasoningEffort: trial.effort }),
  };
}

const OUTPUT_PER_CANDIDATE = { low: 125 + 30, medium: 125 + 113, high: 125 + 250 };

/** Expected and worst-case cost of a plan, from request sizes: no API call. */
export function estimatePlan(dataset: EvalDataset, trials: Trial[], outputCapPerCandidate: number) {
  const byId = new Map(dataset.examples.map((e) => [e.id, e]));
  let expected = 0;
  let worst = 0;
  let calls = 0;
  for (const trial of trials) {
    const stage = stageFor(trial);
    const price = pricingFor(stage.model)!;
    for (const batch of trial.batches) {
      const profile = dataset.profiles[byId.get(batch[0])!.profileKey];
      const request = buildJudgmentRequest(stage, profile.brain, batch.map((id) => byId.get(id)!.input));
      const chars = request.instructions.length + request.input.length + JSON.stringify(request.text).length;
      const output = OUTPUT_PER_CANDIDATE[trial.effort ?? "medium"] * batch.length;
      expected += ((chars / MOCK_ASSUMPTIONS.charsPerToken) * price.input + output * price.output) / 1e6;
      worst += worstCaseUsd(stage, request, outputCap(batch.length, outputCapPerCandidate));
      calls++;
    }
  }
  return { trials: trials.length, calls, expectedUsd: expected, worstCaseUsd: worst };
}

export type TrialResult = {
  name: string;
  kind: Trial["kind"];
  /** Per example id: AI points + freshness, engage */
  scores: Record<string, { score: number; shouldEngage: boolean } | null>;
  calls: number;
  failedCalls: number;
  costUsd: number;
  latencyMs: number;
  stoppedByBudget: boolean;
};

export async function runStability(
  dataset: EvalDataset,
  trials: Trial[],
  {
    mode = "mock",
    budgetUsd = null,
    outputCapPerCandidate = 400,
    onTrial,
  }: {
    mode?: "mock" | "live";
    budgetUsd?: number | null;
    outputCapPerCandidate?: number;
    onTrial?: (result: TrialResult, spentUsd: number) => void;
  } = {},
): Promise<{ results: TrialResult[]; spentUsd: number }> {
  if (mode === "live" && !(budgetUsd && budgetUsd > 0)) throw new Error("A live run needs --budget-usd.");
  const byId = new Map(dataset.examples.map((e) => [e.id, e]));
  const results: TrialResult[] = [];
  let spent = 0;

  await withEvalIsolation(mode, async () => {
    for (const trial of trials) {
      const stage = stageFor(trial);
      const result: TrialResult = {
        name: trial.name,
        kind: trial.kind,
        scores: {},
        calls: 0,
        failedCalls: 0,
        costUsd: 0,
        latencyMs: 0,
        stoppedByBudget: false,
      };
      // One call at a time: each call's worst case is checked against what's left
      for (const batch of trial.batches) {
        const example = byId.get(batch[0])!;
        const profile = dataset.profiles[example.profileKey];
        const candidates = batch.map((id) => byId.get(id)!.input);
        let judgments = new Map<string, CandidateJudgment>();
        result.calls++;
        if (mode === "mock") {
          judgments = new Map(
            candidates.map((c) => [c.candidateId, mockJudgment({ ...stage, model: `${stage.model}:${trial.name}` }, c, byId.get(c.candidateId)!.original)]),
          );
        } else {
          const maxOutputTokens = outputCap(batch.length, outputCapPerCandidate);
          const worst = worstCaseUsd(stage, buildJudgmentRequest(stage, profile.brain, candidates), maxOutputTokens);
          if (spent + worst > (budgetUsd ?? 0)) {
            result.stoppedByBudget = true;
            result.failedCalls++;
            continue;
          }
          try {
            const response = await requestJudgments(stage, profile.brain, candidates, { maxOutputTokens, maxRetries: 0 });
            const usage = response.usage;
            const cost = usage
              ? (estimateCostUsd(response.model, {
                  inputTokens: usage.input_tokens,
                  cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
                  outputTokens: usage.output_tokens,
                }) ?? worst)
              : worst;
            spent += cost;
            result.costUsd += cost;
            result.latencyMs += response.latencyMs;
            if (!response.parsed) result.failedCalls++;
            judgments = response.judgments;
          } catch {
            // Sent, usage unknown: count the reserved worst case
            spent += worst;
            result.costUsd += worst;
            result.failedCalls++;
          }
        }
        for (const id of batch) {
          const judgment = judgments.get(id);
          const freshness = byId.get(id)!.freshness;
          result.scores[id] = judgment
            ? { score: Math.min(100, aiPoints(judgment) + freshness), shouldEngage: judgment.shouldEngage }
            : null;
        }
      }
      results.push(result);
      onTrial?.(result, spent);
    }
  });
  return { results, spentUsd: spent };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const positive = (label: OpportunityLabel) => label === "strong" || label === "acceptable";
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const order = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b), ma = mean(ra), mb = mean(rb);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    n += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : NaN;
}

/** An earlier evaluation run as a free trial: the same posts, scored in other batches. */
export function trialFromRun(name: string, run: { outcomes: { id: string; score: number | null; shouldEngage: boolean | null }[] }): TrialResult {
  return {
    name,
    kind: "regroup",
    scores: Object.fromEntries(
      run.outcomes.map((o) => [o.id, o.score === null ? null : { score: o.score, shouldEngage: Boolean(o.shouldEngage) }]),
    ),
    calls: 0,
    failedCalls: 0,
    costUsd: 0,
    latencyMs: 0,
    stoppedByBudget: false,
  };
}

export function stabilityReport(dataset: EvalDataset, labels: ReviewLabels, results: TrialResult[]) {
  // Posts every trial scored; a post outside a partial trial (e.g. "single") is
  // compared only where present
  const ids = Object.keys(labels).filter((id) => results.filter((r) => r.kind === "repeat").every((r) => r.scores[id]));
  const threshold = (id: string) => dataset.profiles[dataset.examples.find((e) => e.id === id)!.profileKey].threshold;
  const surfaced = (r: TrialResult, id: string) => Boolean(r.scores[id]!.shouldEngage && r.scores[id]!.score >= threshold(id));
  const repeats = results.filter((r) => r.kind === "repeat");

  // Noise between identical runs
  const perPostSd = ids.map((id) => sd(repeats.map((r) => r.scores[id]!.score)));
  const flips = ids.filter((id) => new Set(repeats.map((r) => surfaced(r, id))).size > 1);
  const engageFlips = ids.filter((id) => new Set(repeats.map((r) => r.scores[id]!.shouldEngage)).size > 1);
  // Over the posts both trials scored ("single" covers a subset)
  const pairwise = (a: TrialResult, b: TrialResult) => {
    const shared = ids.filter((id) => a.scores[id] && b.scores[id]);
    return {
      posts: shared.length,
      meanAbsDiff: mean(shared.map((id) => Math.abs(a.scores[id]!.score - b.scores[id]!.score))),
      rankCorrelation: spearman(shared.map((id) => a.scores[id]!.score), shared.map((id) => b.scores[id]!.score)),
      decisionFlips: shared.filter((id) => surfaced(a, id) !== surfaced(b, id)).length,
    };
  };
  const repeatPairs = repeats.flatMap((a, i) => repeats.slice(i + 1).map((b) => pairwise(a, b)));

  // Each variation against the first repeat, next to the repeat-vs-repeat noise floor
  const reference = repeats[0];
  const effects = results.filter((r) => r !== reference).map((r) => ({ name: r.name, ...pairwise(reference, r) }));

  // Quality against the human labels, per trial and for the average of repeats
  const quality = (scoreOf: (id: string) => number, engageOf: (id: string) => boolean, subset = ids) => {
    const ids = subset;
    const shown = ids.filter((id) => engageOf(id) && scoreOf(id) >= threshold(id));
    const strong = ids.filter((id) => labels[id].label === "strong");
    const pos = ids.filter((id) => positive(labels[id].label));
    const auc = (isPos: (l: OpportunityLabel) => boolean) => {
      const P = ids.filter((id) => isPos(labels[id].label)), N = ids.filter((id) => !isPos(labels[id].label));
      let s = 0;
      for (const p of P) for (const n of N) s += scoreOf(p) > scoreOf(n) ? 1 : scoreOf(p) === scoreOf(n) ? 0.5 : 0;
      return P.length && N.length ? s / (P.length * N.length) : NaN;
    };
    return {
      strongRecall: `${strong.filter((id) => shown.includes(id)).length}/${strong.length}`,
      positiveRecall: `${pos.filter((id) => shown.includes(id)).length}/${pos.length}`,
      precision: shown.length ? shown.filter((id) => positive(labels[id].label)).length / shown.length : NaN,
      irrelevantShown: shown.filter((id) => labels[id].label === "irrelevant").length,
      aucStrong: auc((l) => l === "strong"),
      aucPositive: auc(positive),
    };
  };
  const perTrial = results.map((r) => ({
    name: r.name,
    costUsd: r.costUsd,
    latencyMsPerCall: r.calls - r.failedCalls ? r.latencyMs / (r.calls - r.failedCalls) : NaN,
    posts: ids.filter((id) => r.scores[id]).length,
    ...quality(
      (id) => r.scores[id]!.score,
      (id) => r.scores[id]!.shouldEngage,
      ids.filter((id) => r.scores[id]),
    ),
  }));
  const averaged = quality(
    (id) => mean(repeats.map((r) => r.scores[id]!.score)),
    (id) => repeats.filter((r) => r.scores[id]!.shouldEngage).length * 2 >= repeats.length,
  );

  return {
    posts: ids.length,
    noise: {
      meanScoreSd: mean(perPostSd),
      postsSdOver5: perPostSd.filter((x) => x > 5).length,
      postsSdOver10: perPostSd.filter((x) => x > 10).length,
      thresholdCrossingPosts: flips.length,
      engageFlipPosts: engageFlips.length,
      repeatPairs,
    },
    effects,
    perTrial,
    averagedRepeats: averaged,
  };
}
