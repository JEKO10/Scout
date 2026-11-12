// Day 20 scoring evaluation CLI. Run through npm:
//
//   npm run eval:scoring -- audit                       # where scoring cost goes (reads ai_usage)
//   npm run eval:scoring -- export [--per-profile 80]   # dataset from scored candidates (reads only)
//   npm run eval:scoring -- run --strategy cheap        # mock: no API calls, $0
//   npm run eval:scoring -- run --strategy cheap --live --budget-usd 1   # real OpenAI calls
//   npm run eval:scoring -- run-all --live --budget-usd 4               # all strategies, ONE shared budget
//   npm run eval:scoring -- compare [--labels evals/scoring/labels.local.json]
//   npm run eval:scoring -- review [--sample 40]        # blind HTML for a human reviewer
//   npm run eval:scoring -- simulate                    # monthly cost at 1–1,000 users
//
// Files live in evals/scoring/ as *.local.json / *.local.html (git-ignored:
// they contain Scout Brains). Nothing here writes to the database, calls X,
// sends Slack alerts or creates opportunities.
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "evals", "scoring");
const DATASET = path.join(DIR, "dataset.local.json");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8")) as T;
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
};

async function main() {
  const command = process.argv[2];
  const { compareRun, comparisonTable } =
    await import("@/lib/evals/scoring/metrics");
  type Dataset = import("@/lib/evals/scoring/types").EvalDataset;
  type Run = import("@/lib/evals/scoring/types").EvalRun;
  type ScoringStrategyId = import("@/services/opportunities/scoringStrategy").ScoringStrategyId;

  switch (command) {
    case "audit": {
      const { auditScoringCost } = await import("@/lib/evals/scoring/audit");
      const audit = await auditScoringCost();
      console.log(JSON.stringify(audit, null, 2));
      break;
    }
    case "export": {
      const { exportScoringDataset } =
        await import("@/lib/evals/scoring/exportDataset");
      const dataset = await exportScoringDataset({
        perProfile: Number(arg("per-profile") ?? 80),
      });
      writeJson(DATASET, dataset);
      const count = (stratum: string) =>
        dataset.examples.filter((e) => e.strata.includes(stratum)).length;
      console.log(
        `${dataset.examples.length} examples, ${Object.keys(dataset.profiles).length} profiles: ` +
          ["high", "medium", "low", "quote", "labeled", "replied", "saved"]
            .map((s) => `${s} ${count(s)}`)
            .join(", "),
      );
      break;
    }
    case "run": {
      const { runScoringEval } = await import("@/lib/evals/scoring/runner");
      const strategy = (arg("strategy") ?? "baseline") as Run["strategy"];
      const live = flag("live");
      const budget = arg("budget-usd") ? Number(arg("budget-usd")) : null;
      if (live && !budget)
        throw new Error("--live needs --budget-usd <max USD for this run>.");
      const dataset = readJson<Dataset>(DATASET);
      const limit = arg("limit") ? Number(arg("limit")) : undefined;
      // --labeled: only the posts a human reviewer labeled
      const labeled = flag("labeled")
        ? Object.keys(readJson<Record<string, unknown>>(path.join(DIR, "labels.local.json")))
        : undefined;
      const run = await runScoringEval(dataset, strategy as never, {
        mode: live ? "live" : "mock",
        budgetUsd: budget,
        exampleIds: labeled ?? (limit ? dataset.examples.slice(0, limit).map((e) => e.id) : undefined),
        outputTokensPerCandidate: arg("output-cap") ? Number(arg("output-cap")) : undefined,
      });
      writeJson(
        path.join(DIR, `run-${strategy}-${run.mode}${labeled ? "-labeled" : ""}.local.json`),
        run,
      );
      console.log(
        `${run.mode} ${strategy}: ${run.calls} calls (${run.failedCalls} failed), $${run.costUsd.toFixed(4)}` +
          (run.stoppedByBudget ? " — STOPPED BY BUDGET" : ""),
      );
      break;
    }
    case "run-all": {
      // Every strategy, live, under ONE shared budget
      const { runScoringEvals } = await import("@/lib/evals/scoring/runner");
      if (!flag("live")) throw new Error("run-all is live only: --live --budget-usd <total USD>.");
      const total = Number(arg("budget-usd"));
      if (!(total > 0)) throw new Error("--budget-usd <total USD for all strategies> is required.");
      const dataset = readJson<Dataset>(DATASET);
      const strategies = (arg("strategies") ?? "baseline,cheap,optimized,hybrid").split(",") as Run["strategy"][];
      const result = await runScoringEvals(dataset, strategies as ScoringStrategyId[], {
        totalBudgetUsd: total,
        onRun: (run, spent) => {
          writeJson(path.join(DIR, `run-${run.strategy}-live.local.json`), run);
          console.log(
            `live ${run.strategy}: ${run.calls} calls (${run.failedCalls} failed), $${run.costUsd.toFixed(4)}` +
              ` · total spent $${spent.toFixed(4)} of $${total}` +
              (run.stoppedByBudget ? " · STOPPED BY BUDGET" : ""),
          );
        },
      });
      writeJson(path.join(DIR, "ledger-live.local.json"), {
        totalBudgetUsd: total,
        spentUsd: result.spentUsd,
        skipped: result.skipped,
        runs: result.runs.map((run) => ({
          strategy: run.strategy,
          costUsd: run.costUsd,
          unaccountedUsd: run.unaccountedUsd,
        })),
      });
      console.log(
        `Total: $${result.spentUsd.toFixed(4)} of $${total}` +
          (result.skipped.length ? `; skipped ${result.skipped.join(", ")}` : ""),
      );
      break;
    }
    case "cv3": {
      // Prompt v3, cross-validated on the human labels: a post is never scored
      // with its own label among the examples; profiles never share labels
      const { runCrossValidatedV3 } = await import("@/lib/evals/scoring/crossValidation");
      const live = flag("live");
      const budget = arg("budget-usd") ? Number(arg("budget-usd")) : null;
      if (live && !budget) throw new Error("--live needs --budget-usd <max USD>.");
      const dataset = readJson<Dataset>(DATASET);
      const labels = readJson<import("@/lib/evals/scoring/types").ReviewLabels>(path.join(DIR, "labels.local.json"));
      const run = await runCrossValidatedV3(dataset, labels, {
        folds: Number(arg("folds") ?? 2),
        mode: live ? "live" : "mock",
        budgetUsd: budget,
      });
      writeJson(path.join(DIR, `run-${run.strategy}-${run.mode}-labeled.local.json`), run);
      console.log(
        `${run.mode} ${run.strategy}: ${run.calls} calls (${run.failedCalls} failed), $${run.costUsd.toFixed(4)}` +
          (run.stoppedByBudget ? " — STOPPED BY BUDGET" : ""),
      );
      for (const fold of run.folds) {
        console.log(`  ${fold.profileKey} fold ${fold.index}: ${fold.evalIds.length} scored, ${fold.exampleIds.length} examples`);
      }
      break;
    }
    case "prefs": {
      // Offline, $0: reply-preference nudges on scores a model already made,
      // nested leave-one-out per profile (its own labels only)
      const { evaluatePreferences } = await import("@/lib/evals/scoring/preferenceEval");
      const dataset = readJson<Dataset>(DATASET);
      const labels = readJson<import("@/lib/evals/scoring/types").ReviewLabels>(path.join(DIR, "labels.local.json"));
      // --run original: the scores production gave these posts when they were scanned
      const run: Run =
        arg("run") === "original"
          ? ({
              outcomes: dataset.examples.map((example) => {
                const b = example.original.breakdown;
                const score = b
                  ? Math.min(100, b.relevance + b.goalAlignment + b.expertiseFit + b.audienceValue + b.novelty + example.freshness)
                  : null;
                return {
                  id: example.id,
                  score,
                  shouldEngage: example.original.shouldEngage,
                  topic: example.original.topic,
                } as Run["outcomes"][number];
              }),
            } as Run)
          : readJson<Run>(path.join(DIR, arg("run") ?? "run-baseline-live.local.json"));
      const prefsFile = arg("prefs");
      const written = prefsFile
        ? readJson<Record<string, import("@/lib/scout/replyPreferences").ReplyPreferences>>(prefsFile)
        : {};
      const profiles = arg("profile") ? [arg("profile")!] : Object.keys(dataset.profiles);
      const pct = (pair: [number, number]) => `${pair[0]}/${pair[1]}`;
      const two = (value: number | null) => (value === null ? "–" : value.toFixed(2));
      const row = (name: string, m: import("@/lib/evals/scoring/preferenceEval").PrefMetrics) =>
        `| ${name} | ${pct(m.strongRecall)} | ${pct(m.posRecall)} | ${two(m.precision)} | ${m.irrelevantSurfaced} | ${m.weakOrIrrelevantSurfaced} | ${two(m.aucStrong)} | ${two(m.aucPositive)} |`;
      const results = [];
      for (const profileKey of profiles) {
        const sources = [
          { kind: "ratings" as const },
          ...(written[profileKey] ? [{ kind: "settings" as const, preferences: written[profileKey] }] : []),
        ];
        console.log(`\n### ${profileKey} (threshold ${dataset.profiles[profileKey].threshold})`);
        console.log("| Variant | Strong | Strong+acc | Precision | Irrelevant shown | Weak+irrelevant shown | AUC strong | AUC str+acc |");
        console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
        for (const source of sources) {
          const result = evaluatePreferences(dataset, labels, run, profileKey, source);
          results.push(result);
          if (source.kind === "ratings") console.log(row("baseline (no preferences)", result.baseline));
          console.log(row(`+ ${source.kind} preferences, cross-validated`, result.crossValidated));
          console.log(row(`(in-sample best, NOT evidence) ${JSON.stringify(result.inSampleBest.nudge)}`, result.inSampleBest.metrics));
          const changed = result.chosen.filter((c) => c.surfacedBefore !== c.surfacedAfter || c.before !== c.after);
          for (const c of changed) {
            console.log(
              `   ${c.label.padEnd(10)} ${c.before}→${c.after} ${c.surfacedBefore ? "S" : "-"}→${c.surfacedAfter ? "S" : "-"} with ${JSON.stringify(c.nudge)}`,
            );
          }
        }
      }
      writeJson(path.join(DIR, "prefs-offline.local.json"), results);
      break;
    }
    case "stability": {
      // Same prompt, same posts, repeated and varied one factor at a time.
      // Without --live: cost estimate and a mock run ($0).
      const { buildTrials, estimatePlan, runStability, stabilityReport, trialFromRun } = await import(
        "@/lib/evals/scoring/stability"
      );
      const dataset = readJson<Dataset>(DATASET);
      const labels = readJson<import("@/lib/evals/scoring/types").ReviewLabels>(path.join(DIR, "labels.local.json"));
      const plan = (arg("plan") ?? "minimal") as "minimal" | "full" | "low-repeat";
      const trials = buildTrials(dataset, labels, plan);
      const cap = Number(arg("output-cap") ?? 400);
      const estimate = estimatePlan(dataset, trials, cap);
      console.log(
        `Plan ${plan}: ${estimate.trials} trials, ${estimate.calls} calls · expected ~$${estimate.expectedUsd.toFixed(2)}` +
          ` · sum of per-call worst cases $${estimate.worstCaseUsd.toFixed(2)} (the guard reserves one call at a time)`,
      );
      for (const trial of trials) console.log(`  ${trial.name}: ${trial.batches.length} calls`);
      const live = flag("live");
      const budget = arg("budget-usd") ? Number(arg("budget-usd")) : null;
      if (live && !budget) throw new Error("--live needs --budget-usd <max USD for the whole plan>.");
      const { results, spentUsd } = await runStability(dataset, trials, {
        mode: live ? "live" : "mock",
        budgetUsd: budget,
        outputCapPerCandidate: cap,
        onTrial: (result, spent) =>
          console.log(`  done ${result.name}: $${result.costUsd.toFixed(4)} (total $${spent.toFixed(4)})${result.stoppedByBudget ? " STOPPED BY BUDGET" : ""}`),
      });
      // low-repeat: the earlier low-effort run joins as a third repeat
      const minimalFile = path.join(DIR, "stability-minimal-live.local.json");
      if (plan === "low-repeat" && existsSync(minimalFile)) {
        const earlierLow = readJson<{ results: typeof results }>(minimalFile).results.find((r) => r.name === "effort-low");
        if (earlierLow) results.unshift({ ...earlierLow, name: "effort-low-1", kind: "repeat" });
      }
      const earlier = path.join(DIR, "run-baseline-live.local.json");
      if (plan === "minimal" && existsSync(earlier)) results.push(trialFromRun("regroup-earlier-run", readJson<Run>(earlier)));
      const report = stabilityReport(dataset, labels, results);
      const mode = live ? "live" : "mock";
      writeJson(path.join(DIR, `stability-${plan}-${mode}.local.json`), { results, report, spentUsd });
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    case "compare": {
      const dataset = readJson<Dataset>(DATASET);
      const mode = flag("live") ? "live" : "mock";
      const runs = readdirSync(DIR)
        .filter(
          (file) =>
            file.startsWith("run-") && file.endsWith(`-${mode}.local.json`),
        )
        .map((file) => readJson<Run>(path.join(DIR, file)));
      const baseline = runs.find((run) => run.strategy === "baseline") ?? null;
      const labelsFile = arg("labels");
      const labels =
        labelsFile && existsSync(labelsFile) ? readJson(labelsFile) : undefined;
      const rows = runs
        .sort((a, b) =>
          a.strategy === "baseline" ? -1 : b.strategy === "baseline" ? 1 : 0,
        )
        .map((run) => compareRun(dataset, run, baseline, labels as never));
      const table = comparisonTable(rows);
      console.log(table);
      writeJson(path.join(DIR, `comparison-${mode}.local.json`), rows);
      break;
    }
    case "review": {
      const { buildReview, reviewSample } =
        await import("@/lib/evals/scoring/review");
      const dataset = readJson<Dataset>(DATASET);
      const mode = flag("mock") ? "mock" : "live";
      const runs = readdirSync(DIR)
        .filter(
          (file) =>
            file.startsWith("run-") && file.endsWith(`-${mode}.local.json`),
        )
        .map((file) => readJson<Run>(path.join(DIR, file)));
      if (runs.length === 0) throw new Error(`No ${mode} runs yet.`);
      const ids = reviewSample(dataset, runs, Number(arg("sample") ?? 40));
      const { html, key } = buildReview(dataset, runs, ids);
      writeFileSync(path.join(DIR, "review.local.html"), html);
      writeJson(path.join(DIR, "review-key.local.json"), key);
      console.log(
        `Open evals/scoring/review.local.html (${ids.length} posts).`,
      );
      break;
    }
    case "simulate": {
      const { DEFAULT_ASSUMPTIONS, simulateMonthlyCost, simulationTable } =
        await import("@/lib/evals/scoring/costSimulator");
      const file = path.join(
        DIR,
        `comparison-${flag("live") ? "live" : "mock"}.local.json`,
      );
      const rows = existsSync(file)
        ? readJson<ReturnType<typeof compareRun>[]>(file)
        : [];
      const strategies = rows.length
        ? rows
        : [
            {
              strategy: "baseline",
              costPerCandidate: DEFAULT_ASSUMPTIONS.primaryCostPerCandidate,
              prefiltered: 0,
              examples: 1,
            },
          ];
      for (const row of strategies) {
        const assumptions = {
          ...DEFAULT_ASSUMPTIONS,
          // The comparison's cost per candidate already includes both stages and the pre-filter
          primaryCostPerCandidate: row.costPerCandidate,
        };
        console.log(
          simulationTable(
            [1, 10, 100, 1000].map((users) =>
              simulateMonthlyCost(users, assumptions),
            ),
            `${row.strategy}`,
          ),
          "\n",
        );
      }
      break;
    }
    default:
      console.log(
        readFileSync(__filename, "utf8").split("\n").slice(0, 14).join("\n"),
      );
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
