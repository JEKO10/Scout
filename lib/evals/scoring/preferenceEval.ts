import {
  applyPreferenceNudge,
  type PreferenceNudge,
  type ReplyPreferences,
} from "@/lib/scout/replyPreferences";

import type { EvalDataset, EvalRun, OpportunityLabel, ReviewLabels } from "./types";

// Offline: can reply preferences fix existing baseline scores, with no API
// call? Nudges are applied to scores a model already produced, then compared
// with the user's labels. Parameters are chosen by nested leave-one-out
// cross-validation: every post is predicted by settings chosen without it,
// and (in "ratings" mode) by preferences learned without it. One profile at
// a time: its own labels only.

export type PrefSource =
  /** Learned from the user's other ratings on the same profile */
  | { kind: "ratings" }
  /** Written by the user (Settings → Reply preferences) */
  | { kind: "settings"; preferences: ReplyPreferences };

export const NUDGE_GRID: PreferenceNudge[] = (() => {
  const grid: PreferenceNudge[] = [];
  for (const wantPoints of [0, 3, 6, 10, 15])
    for (const avoidPoints of [0, 3, 6, 10, 15, 25])
      for (const minOverlap of [1, 2, 3, 4])
        for (const wantOverridesEngage of [false, true])
          grid.push({ wantPoints, avoidPoints, minOverlap, wantOverridesEngage });
  return grid;
})();

const NO_NUDGE: PreferenceNudge = { wantPoints: 0, avoidPoints: 0, minOverlap: 1, wantOverridesEngage: false };

const positive = (label: OpportunityLabel) => label === "strong" || label === "acceptable";

type Item = {
  id: string;
  label: OpportunityLabel;
  /** Post text plus the model's topic: what preferences are matched against */
  text: string;
  score: number;
  shouldEngage: boolean;
};

export type PrefMetrics = {
  n: number;
  surfaced: number;
  strongRecall: [number, number];
  posRecall: [number, number];
  precision: number | null;
  irrelevantSurfaced: number;
  weakOrIrrelevantSurfaced: number;
  aucStrong: number | null;
  aucPositive: number | null;
};

function auc(items: Item[], scores: Map<string, number>, isPos: (label: OpportunityLabel) => boolean): number | null {
  const P = items.filter((item) => isPos(item.label));
  const N = items.filter((item) => !isPos(item.label));
  if (!P.length || !N.length) return null;
  let sum = 0;
  for (const p of P)
    for (const n of N) {
      const a = scores.get(p.id)!;
      const b = scores.get(n.id)!;
      sum += a > b ? 1 : a === b ? 0.5 : 0;
    }
  return sum / (P.length * N.length);
}

export function prefMetrics(items: Item[], predicted: Map<string, { score: number; surfaced: boolean }>): PrefMetrics {
  const surfaced = items.filter((item) => predicted.get(item.id)!.surfaced);
  const strong = items.filter((item) => item.label === "strong");
  const pos = items.filter((item) => positive(item.label));
  const scores = new Map([...predicted].map(([id, value]) => [id, value.score]));
  return {
    n: items.length,
    surfaced: surfaced.length,
    strongRecall: [strong.filter((item) => predicted.get(item.id)!.surfaced).length, strong.length],
    posRecall: [pos.filter((item) => predicted.get(item.id)!.surfaced).length, pos.length],
    precision: surfaced.length ? surfaced.filter((item) => positive(item.label)).length / surfaced.length : null,
    irrelevantSurfaced: surfaced.filter((item) => item.label === "irrelevant").length,
    weakOrIrrelevantSurfaced: surfaced.filter((item) => !positive(item.label)).length,
    aucStrong: auc(items, scores, (label) => label === "strong"),
    aucPositive: auc(items, scores, positive),
  };
}

/** Recall-weighted (F2) on strong+acceptable; fewer weak/irrelevant breaks ties. */
function objective(m: PrefMetrics): number {
  const recall = m.posRecall[1] ? m.posRecall[0] / m.posRecall[1] : 0;
  const precision = m.precision ?? 0;
  const f2 = recall + precision === 0 ? 0 : (5 * precision * recall) / (4 * precision + recall);
  return f2 - 0.001 * m.weakOrIrrelevantSurfaced;
}

function preferencesFrom(source: PrefSource, train: Item[]): ReplyPreferences {
  if (source.kind === "settings") return source.preferences;
  return {
    want: train.filter((item) => positive(item.label)).map((item) => item.text),
    avoid: train.filter((item) => !positive(item.label)).map((item) => item.text),
  };
}

function predict(item: Item, preferences: ReplyPreferences, nudge: PreferenceNudge, threshold: number) {
  const result = applyPreferenceNudge(
    { text: item.text, score: item.score, shouldEngage: item.shouldEngage },
    // A post never matches itself
    { want: preferences.want.filter((text) => text !== item.text), avoid: preferences.avoid.filter((text) => text !== item.text) },
    nudge,
    threshold,
  );
  return { score: result.score, surfaced: result.surfaced };
}

/** Picks the nudge with leave-one-out inside `train` only. */
function chooseNudge(train: Item[], source: PrefSource, threshold: number): PreferenceNudge {
  let best = NO_NUDGE;
  let bestValue = -Infinity;
  for (const nudge of NUDGE_GRID) {
    const predictions = new Map(
      train.map((item) => {
        const rest = train.filter((other) => other.id !== item.id);
        return [item.id, predict(item, preferencesFrom(source, rest), nudge, threshold)];
      }),
    );
    const value = objective(prefMetrics(train, predictions));
    // Strictly better only: ties keep the smaller, earlier nudge
    if (value > bestValue + 1e-9) {
      bestValue = value;
      best = nudge;
    }
  }
  return best;
}

export type PreferenceEvalResult = {
  profileKey: string;
  source: PrefSource["kind"];
  baseline: PrefMetrics;
  crossValidated: PrefMetrics;
  /** The nudge each held-out post was predicted with (they differ per fold) */
  chosen: { id: string; label: OpportunityLabel; nudge: PreferenceNudge; before: number; after: number; surfacedBefore: boolean; surfacedAfter: boolean }[];
  /** In-sample best on ALL labels: an upper bound, not evidence */
  inSampleBest: { nudge: PreferenceNudge; metrics: PrefMetrics };
};

export function evaluatePreferences(
  dataset: EvalDataset,
  labels: ReviewLabels,
  run: EvalRun,
  profileKey: string,
  source: PrefSource,
): PreferenceEvalResult {
  const outcomes = new Map(run.outcomes.map((outcome) => [outcome.id, outcome]));
  const threshold = dataset.profiles[profileKey].threshold;
  const items: Item[] = dataset.examples
    .filter((example) => example.profileKey === profileKey && labels[example.id])
    .flatMap((example) => {
      const outcome = outcomes.get(example.id);
      if (!outcome || outcome.score === null) return [];
      const text = [example.input.content, example.input.quotedPost ?? "", outcome.topic ?? ""].join(" ");
      return [{ id: example.id, label: labels[example.id].label, text, score: outcome.score, shouldEngage: Boolean(outcome.shouldEngage) }];
    });

  const baselinePredictions = new Map(
    items.map((item) => [item.id, { score: item.score, surfaced: item.shouldEngage && item.score >= threshold }]),
  );

  const chosen: PreferenceEvalResult["chosen"] = [];
  const cvPredictions = new Map<string, { score: number; surfaced: boolean }>();
  for (const item of items) {
    const train = items.filter((other) => other.id !== item.id);
    const nudge = chooseNudge(train, source, threshold);
    const prediction = predict(item, preferencesFrom(source, train), nudge, threshold);
    cvPredictions.set(item.id, prediction);
    chosen.push({
      id: item.id,
      label: item.label,
      nudge,
      before: item.score,
      after: prediction.score,
      surfacedBefore: baselinePredictions.get(item.id)!.surfaced,
      surfacedAfter: prediction.surfaced,
    });
  }

  // For transparency only: the best nudge when tuned on every label
  let inSampleBest = { nudge: NO_NUDGE, metrics: prefMetrics(items, baselinePredictions) };
  let bestValue = objective(inSampleBest.metrics);
  for (const nudge of NUDGE_GRID) {
    const predictions = new Map(
      items.map((item) => [item.id, predict(item, preferencesFrom(source, items.filter((o) => o.id !== item.id)), nudge, threshold)]),
    );
    const metrics = prefMetrics(items, predictions);
    if (objective(metrics) > bestValue + 1e-9) {
      bestValue = objective(metrics);
      inSampleBest = { nudge, metrics };
    }
  }

  return {
    profileKey,
    source: source.kind,
    baseline: prefMetrics(items, baselinePredictions),
    crossValidated: prefMetrics(items, cvPredictions),
    chosen,
    inSampleBest,
  };
}
