import type { EvalDataset, EvalOutcome, EvalRun, ReviewLabels } from "./types";

// Comparing evaluation runs. Agreement with the baseline is one signal, not
// the measure of quality: the baseline is a model too. Quality claims need
// human labels (review.ts); without them every quality number is provisional.

export type RunComparison = {
  strategy: string;
  mode: "mock" | "live";
  examples: number;
  /** Judged (not pre-filtered) / sent to a model */
  validity: number;
  prefiltered: number;
  costUsd: number;
  costPer100: number;
  /** Per scored-or-prefiltered candidate */
  costPerCandidate: number;
  avgLatencyMsPerCall: number | null;
  calls: number;
  failedCalls: number;
  escalated: number;
  tokensPerCandidate: { input: number; output: number; reasoning: number };
  vsBaseline: {
    compared: number;
    meanAbsScoreDiff: number | null;
    /** Spearman rank correlation of scores */
    rankCorrelation: number | null;
    /** Baseline-surfaced posts this strategy also surfaced */
    surfacedRecall: number | null;
    /** This strategy's surfaced posts the baseline also surfaced */
    surfacedPrecision: number | null;
    /** Overlap of each profile's top 10 */
    top10Overlap: number | null;
    /** Baseline-surfaced posts the pre-filter removed before scoring */
    lostToPrefilter: number;
    quoteAgreement: number | null;
  };
  /** From human review labels and user signals (provisional when few) */
  vsHumans: {
    labeled: number;
    /** strong/acceptable (or user YES/replied/saved) that this strategy surfaced */
    recall: number | null;
    /** surfaced among labeled that were strong/acceptable */
    precision: number | null;
    precisionAtK: { k: number; value: number | null };
    falsePositiveRate: number | null;
    falseNegativeRate: number | null;
    provisional: boolean;
  };
};

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

function ranks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    for (let k = i; k <= j; k++) result[order[k].index] = (i + j) / 2;
    i = j + 1;
  }
  return result;
}

export function spearman(a: number[], b: number[]): number | null {
  if (a.length < 3) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

/**
 * Ground truth where we have any: a reviewer's label wins; otherwise the
 * user's own signals (Day 9 YES/NO, replied, saved). Null: unknown.
 */
export function humanVerdict(
  example: EvalDataset["examples"][number],
  labels: ReviewLabels | undefined,
): boolean | null {
  const label = labels?.[example.id]?.label;
  if (label) return label === "strong" || label === "acceptable";
  if (example.original.userLabel === "yes") return true;
  if (example.original.userLabel === "no") return false;
  if (
    example.original.opportunityStatus === "replied" ||
    example.original.opportunityStatus === "saved"
  ) {
    return true;
  }
  if (example.original.opportunityStatus === "dismissed") return false;
  return null;
}

function topIds(
  outcomes: EvalOutcome[],
  dataset: EvalDataset,
  k: number,
): Set<string> {
  const byProfile = new Map<string, EvalOutcome[]>();
  const profileOf = new Map(
    dataset.examples.map((example) => [example.id, example.profileKey]),
  );
  for (const outcome of outcomes) {
    if (outcome.score === null) continue;
    const key = profileOf.get(outcome.id) ?? "";
    byProfile.set(key, [...(byProfile.get(key) ?? []), outcome]);
  }
  const ids = new Set<string>();
  for (const list of byProfile.values()) {
    for (const outcome of [...list]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, k))
      ids.add(outcome.id);
  }
  return ids;
}

export function compareRun(
  dataset: EvalDataset,
  run: EvalRun,
  baseline: EvalRun | null,
  labels?: ReviewLabels,
): RunComparison {
  const outcomes = new Map(
    run.outcomes.map((outcome) => [outcome.id, outcome]),
  );
  const scored = run.outcomes.filter((outcome) => outcome.score !== null);
  const prefiltered = run.outcomes.filter(
    (outcome) => outcome.prefiltered,
  ).length;
  const sent = run.examples - prefiltered;
  const handled = scored.length + prefiltered;

  // Versus baseline
  const base = baseline
    ? new Map(baseline.outcomes.map((outcome) => [outcome.id, outcome]))
    : null;
  const pairs: [EvalOutcome, EvalOutcome][] = [];
  if (base) {
    for (const outcome of scored) {
      const other = base.get(outcome.id);
      if (other && other.score !== null) pairs.push([outcome, other]);
    }
  }
  const baseSurfaced = baseline
    ? baseline.outcomes.filter((outcome) => outcome.surfaced)
    : [];
  const runSurfaced = run.outcomes.filter((outcome) => outcome.surfaced);
  const quoteIds = new Set(
    dataset.examples.filter((e) => e.input.quotedPost).map((e) => e.id),
  );
  const quotePairs = pairs.filter(([outcome]) => quoteIds.has(outcome.id));
  const topRun = topIds(run.outcomes, dataset, 10);
  const topBase = baseline
    ? topIds(baseline.outcomes, dataset, 10)
    : new Set<string>();

  // Versus humans
  const judged = dataset.examples
    .map((example) => ({ example, verdict: humanVerdict(example, labels) }))
    .filter(
      (item): item is { example: (typeof item)["example"]; verdict: boolean } =>
        item.verdict !== null,
    );
  const positives = judged.filter((item) => item.verdict);
  const negatives = judged.filter((item) => !item.verdict);
  const surfacedOf = (id: string) => outcomes.get(id)?.surfaced ?? false;
  const surfacedJudged = judged.filter((item) => surfacedOf(item.example.id));
  const k = Math.min(10, positives.length);
  const topK = [...judged]
    .filter((item) => outcomes.get(item.example.id)?.score !== null)
    .sort(
      (a, b) =>
        (outcomes.get(b.example.id)?.score ?? 0) -
        (outcomes.get(a.example.id)?.score ?? 0),
    )
    .slice(0, k);

  return {
    strategy: run.strategy,
    mode: run.mode,
    examples: run.examples,
    validity: ratio(scored.length, sent) ?? 0,
    prefiltered,
    costUsd: run.costUsd,
    costPer100: handled ? (run.costUsd / handled) * 100 : 0,
    costPerCandidate: handled ? run.costUsd / handled : 0,
    avgLatencyMsPerCall: ratio(run.latencyMs, run.calls - run.failedCalls),
    calls: run.calls,
    failedCalls: run.failedCalls,
    escalated: run.escalated,
    tokensPerCandidate: {
      input: handled ? run.tokens.input / handled : 0,
      output: handled ? run.tokens.output / handled : 0,
      reasoning: handled ? run.tokens.reasoning / handled : 0,
    },
    vsBaseline: {
      compared: pairs.length,
      meanAbsScoreDiff: pairs.length
        ? pairs.reduce(
            (sum, [a, b]) => sum + Math.abs((a.score ?? 0) - (b.score ?? 0)),
            0,
          ) / pairs.length
        : null,
      rankCorrelation: spearman(
        pairs.map(([a]) => a.score ?? 0),
        pairs.map(([, b]) => b.score ?? 0),
      ),
      surfacedRecall: baseline
        ? ratio(
            baseSurfaced.filter((o) => surfacedOf(o.id)).length,
            baseSurfaced.length,
          )
        : null,
      surfacedPrecision: base
        ? ratio(
            runSurfaced.filter((o) => base.get(o.id)?.surfaced).length,
            runSurfaced.length,
          )
        : null,
      top10Overlap: baseline
        ? ratio(
            [...topRun].filter((id) => topBase.has(id)).length,
            topBase.size,
          )
        : null,
      lostToPrefilter: baseSurfaced.filter(
        (o) => outcomes.get(o.id)?.prefiltered,
      ).length,
      quoteAgreement: quotePairs.length
        ? quotePairs.filter(([a, b]) => a.surfaced === b.surfaced).length /
          quotePairs.length
        : null,
    },
    vsHumans: {
      labeled: judged.length,
      recall: ratio(
        positives.filter((item) => surfacedOf(item.example.id)).length,
        positives.length,
      ),
      precision: ratio(
        surfacedJudged.filter((item) => item.verdict).length,
        surfacedJudged.length,
      ),
      precisionAtK: {
        k,
        value: k ? topK.filter((item) => item.verdict).length / k : null,
      },
      falsePositiveRate: ratio(
        negatives.filter((item) => surfacedOf(item.example.id)).length,
        negatives.length,
      ),
      falseNegativeRate: ratio(
        positives.filter((item) => !surfacedOf(item.example.id)).length,
        positives.length,
      ),
      provisional: !labels || Object.keys(labels).length < 30,
    },
  };
}

const pct = (value: number | null) =>
  value === null ? "–" : `${Math.round(value * 100)}%`;
const num = (value: number | null, digits = 1) =>
  value === null ? "–" : value.toFixed(digits);

/** Markdown summary of several comparisons (the first is usually the baseline). */
export function comparisonTable(rows: RunComparison[]): string {
  const base = rows.find((row) => row.strategy === "baseline");
  const lines = [
    "| Strategy | Mode | $/100 posts | Savings | Valid | Pre-filtered | Escalated | Rank corr. | Surfaced recall vs baseline | Precision vs baseline | Lost to pre-filter | Human recall | Human precision | Latency/call |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    const savings =
      base && base.costPer100 > 0 ? 1 - row.costPer100 / base.costPer100 : null;
    lines.push(
      `| ${row.strategy} | ${row.mode} | $${row.costPer100.toFixed(3)} | ${row === base ? "baseline" : pct(savings)} | ${pct(row.validity)} | ${row.prefiltered} | ${row.escalated} | ${num(row.vsBaseline.rankCorrelation, 2)} | ${pct(row.vsBaseline.surfacedRecall)} | ${pct(row.vsBaseline.surfacedPrecision)} | ${row.vsBaseline.lostToPrefilter} | ${pct(row.vsHumans.recall)} | ${pct(row.vsHumans.precision)} | ${row.avgLatencyMsPerCall === null ? "–" : `${(row.avgLatencyMsPerCall / 1000).toFixed(1)} s`} |`,
    );
  }
  return lines.join("\n");
}
