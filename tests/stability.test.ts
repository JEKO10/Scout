// Day 21 scoring stability harness: trial design, budget guard and report.
// OpenAI is mocked; nothing here costs money or touches the app's data.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { getProfileById } from "@/db/queries/profiles";
import { buildTrials, runStability, stabilityReport, type TrialResult } from "@/lib/evals/scoring/stability";
import type { EvalDataset, ReviewLabels } from "@/lib/evals/scoring/types";
import { BASELINE_STAGE, brainForRanking } from "@/services/opportunities/scoreOpportunity";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

import { cleanup, newProfile, rememberXUsage } from "./helpers/db";
import { ai, installMocks, slack, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

const LABELS = ["strong", "acceptable", "weak", "irrelevant"] as const;

async function fixture() {
  const p = await newProfile();
  const brain = brainForRanking(resolveScoutBrain((await getProfileById(p.id))!)!);
  const examples: EvalDataset["examples"] = [];
  const labels: ReviewLabels = {};
  for (const [k, profileKey] of ["profile-1", "profile-2"].entries()) {
    for (let i = 0; i < 12; i++) {
      const id = `00000000-0000-4000-8000-0000000${k}${String(i).padStart(4, "0")}`;
      examples.push({
        id,
        profileKey,
        input: { candidateId: id, authorHandle: "a", kind: "post", hoursAgo: 1, replies: 0, content: `AI coding take ${k}-${i}`, history: [] },
        freshness: 15,
        postedAt: new Date().toISOString(),
        url: "https://x.com/a/status/1",
        strata: ["medium"],
        original: { score: 60, breakdown: null, shouldEngage: true, reason: null, suggestedAngle: null, topic: null, surfaced: false, opportunityStatus: null, userLabel: null },
      });
      labels[id] = { label: LABELS[i % 4] };
    }
  }
  const dataset: EvalDataset = {
    version: 1,
    exportedAt: "",
    profiles: { "profile-1": { brain, userWriting: [], threshold: 60 }, "profile-2": { brain, userWriting: [], threshold: 50 } },
    examples,
  };
  return { dataset, labels, examples };
}

test("trials vary one thing at a time, within one profile", async () => {
  const { dataset, labels, examples } = await fixture();
  const trials = buildTrials(dataset, labels, "full");
  const by = (name: string) => trials.find((t) => t.name === name)!;
  const profileOf = (id: string) => examples.find((e) => e.id === id)!.profileKey;
  for (const trial of trials) {
    for (const batch of trial.batches) assert.equal(new Set(batch.map(profileOf)).size, 1, `${trial.name}: one profile per call`);
  }
  assert.deepEqual(by("repeat-1").batches, by("repeat-2").batches, "repeats are identical");
  assert.deepEqual(by("effort-low").batches, by("repeat-1").batches);
  const sorted = (batches: string[][]) => batches.map((b) => [...b].sort().join());
  assert.deepEqual(sorted(by("shuffle-1").batches), sorted(by("repeat-1").batches), "same members");
  assert.notDeepEqual(by("shuffle-1").batches, by("repeat-1").batches, "different order");
  assert.notDeepEqual(sorted(by("regroup-1").batches), sorted(by("repeat-1").batches), "different neighbours");
  assert.ok(by("single").batches.every((b) => b.length === 1));
  assert.equal(by("single").batches.length, 24);
  // Minimal: fewer singles, no paid regroup (an earlier run stands in)
  const minimal = buildTrials(dataset, labels, "minimal");
  assert.equal(minimal.find((t) => t.name === "single")!.batches.length, 20);
  assert.equal(minimal.some((t) => t.kind === "regroup"), false);
});

test("live run: production request per call, budget never exceeded, no X or Slack", async () => {
  const { dataset, labels } = await fixture();
  const trials = buildTrials(dataset, labels, "minimal");
  const before = { x: x.calls.length, slack: slack.calls.length };
  ai.requests.length = 0;
  await assert.rejects(runStability(dataset, trials, { mode: "live" }));

  const { results, spentUsd } = await runStability(dataset, trials, { mode: "live", budgetUsd: 0.2 });
  assert.ok(spentUsd <= 0.2, `${spentUsd}`);
  assert.ok(results.some((r) => r.stoppedByBudget), "the small budget stops the plan");
  const requests = ai.requests.filter((b) => (b.text as { format?: { name?: string } })?.format?.name === "candidate_judgments");
  for (const body of requests) {
    assert.equal(body.model, BASELINE_STAGE.model);
    const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
    assert.ok(effort === undefined || effort === "low", "default effort, or the low-effort trial");
    assert.ok(typeof body.max_output_tokens === "number", "capped");
  }
  assert.deepEqual({ x: x.calls.length, slack: slack.calls.length }, before);
});

test("report: noise, threshold crossings and effects against the noise floor", async () => {
  const { dataset, labels, examples } = await fixture();
  const ids = examples.map((e) => e.id);
  const trial = (name: string, kind: TrialResult["kind"], scoreOf: (i: number) => number): TrialResult => ({
    name,
    kind,
    scores: Object.fromEntries(ids.map((id, i) => [id, { score: scoreOf(i), shouldEngage: true }])),
    calls: 1,
    failedCalls: 0,
    costUsd: 0,
    latencyMs: 0,
    stoppedByBudget: false,
  });
  // Post 0 swings 40 ↔ 80 between identical runs; everything else is steady
  const a = trial("repeat-1", "repeat", (i) => (i === 0 ? 40 : 30 + i));
  const b = trial("repeat-2", "repeat", (i) => (i === 0 ? 80 : 30 + i));
  const shifted = trial("single", "single", (i) => 40 + i);
  const report = stabilityReport(dataset, labels, [a, b, shifted]);
  assert.equal(report.posts, 24);
  assert.equal(report.noise.thresholdCrossingPosts, 1);
  assert.equal(report.noise.postsSdOver10, 1);
  assert.equal(report.noise.repeatPairs[0].decisionFlips, 1);
  const single = report.effects.find((e) => e.name === "single")!;
  assert.ok(single.meanAbsDiff > report.noise.repeatPairs[0].meanAbsDiff, "a systematic shift shows above the noise");
});
