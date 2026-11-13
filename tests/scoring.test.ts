// Day 20: scoring strategies, the pre-filter and the offline evaluation.
// OpenAI, X and Slack are mocked; the database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { eq, inArray, sql } from "drizzle-orm";

import db from "@/db";
import { getProfileById } from "@/db/queries/profiles";
import * as s from "@/db/schema";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { makeFolds, runCrossValidatedV3 } from "@/lib/evals/scoring/crossValidation";
import { compareRun } from "@/lib/evals/scoring/metrics";
import {
  EvalBudgetError,
  EvalIsolationError,
  outputCap,
  runScoringEval,
  runScoringEvals,
  withEvalIsolation,
} from "@/lib/evals/scoring/runner";
import type { EvalDataset, ReviewLabels } from "@/lib/evals/scoring/types";
import { withQuotedPost } from "@/lib/posts/quotedPost";
import { prefilterCandidates } from "@/lib/scout/prefilter";
import { rankCandidates } from "@/services/opportunities/rankCandidates";
import {
  BASELINE_STAGE,
  brainForRanking,
  SCORING_PROMPTS,
} from "@/services/opportunities/scoreOpportunity";
import { getScoringStrategy, SCORING_STRATEGIES } from "@/services/opportunities/scoringStrategy";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

import { cleanup, newProfile, rememberXUsage } from "./helpers/db";
import { ai, installMocks, slack, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);
beforeEach(() => {
  ai.requests.length = 0;
  ai.failures.length = 0;
  delete process.env.SCOUT_SCORING_STRATEGY;
  delete process.env.OPENAI_SCORING_REASONING_EFFORT;
});
afterEach(() => {
  delete process.env.SCOUT_SCORING_STRATEGY;
  delete process.env.OPENAI_SCORING_REASONING_EFFORT;
});

let seq = 0;

/** A run with `count` unscored candidates (posted an hour ago). */
async function withCandidates(
  profileId: string,
  count: number,
  make: (index: number) => string = (index) => `Post ${index}: how do you price an AI product for founders?`,
) {
  // Completed: one profile may only have one active run
  const [run] = await db.insert(s.scoutRunsTable).values({ profileId, status: "completed" }).returning();
  const rows = await db
    .insert(s.scoutCandidatesTable)
    .values(
      Array.from({ length: count }, (_, index) => ({
        runId: run.id,
        profileId,
        platform: "x" as const,
        platformPostId: `s${Date.now()}${seq++}`,
        authorHandle: "founder",
        content: make(index),
        url: "https://x.com/founder/status/1",
        kind: "post" as const,
        postedAt: new Date(Date.now() - 3600_000),
        source: "x_api",
      })),
    )
    .returning();
  return { run, candidates: rows };
}

const candidatesOf = (profileId: string) =>
  db.select().from(s.scoutCandidatesTable).where(eq(s.scoutCandidatesTable.profileId, profileId));
const scoringRequests = () =>
  ai.requests.filter((body) => (body.text as { format?: { name?: string } })?.format?.name === "candidate_judgments");
const idsIn = (body: Record<string, unknown>) =>
  [...String(body.input).matchAll(/"candidateId":\s*"([^"]+)"/g)].map((match) => match[1]);

test("1: baseline is the Day 9 request with low reasoning effort", async () => {
  // The v1 prompt is frozen: this hash is the committed Day 9 text
  const hash = createHash("sha256").update(SCORING_PROMPTS.v1.instructions).digest("hex");
  assert.equal(hash, "47bb96de3dcf5a07819a3de6a243380085bbed3d03750a88d3f822794a11e048");
  assert.equal(getScoringStrategy().id, "baseline", "baseline is the default");

  const p = await newProfile();
  const { run } = await withCandidates(p.id, 23);
  const stats = await rankCandidates(p.id, run.id);

  const requests = scoringRequests();
  assert.equal(requests.length, 3, "batches of 10");
  for (const body of requests) {
    assert.equal(body.model, BASELINE_STAGE.model);
    assert.equal(body.instructions, SCORING_PROMPTS.v1.instructions);
    assert.ok(String(body.input).startsWith("## Scout Brain\n{\n  "), "pretty JSON as before");
    assert.deepEqual(body.reasoning, { effort: "low" }, "Day 21: low effort in production");
    assert.equal(body.prompt_cache_key, undefined);
    assert.equal(body.max_output_tokens, undefined, "no output cap in production");
    assert.equal((body.text as { verbosity?: string }).verbosity, undefined);
  }
  assert.equal(stats.scored, 23);
  assert.equal(stats.strategy, "baseline");
  assert.equal(stats.prefiltered, 0);
  assert.equal(stats.calls, 3);
});

test("2: the pre-filter keeps valuable edge cases", () => {
  const items = [
    { candidateId: "question", content: "Pricing?" },
    { candidateId: "short-question", content: "worth it?" },
    { candidateId: "small-account-take", content: "AI agents still can't do support well" },
    { candidateId: "adjacent", content: "Hiring my first designer as a solo founder, any tips on scope" },
    { candidateId: "short-quote", content: "This.", quotedPost: "Most SaaS founders underprice by 3x because they anchor on competitors instead of value" },
    { candidateId: "link-plus-text", content: "We shipped the new onboarding https://t.co/abc" },
    { candidateId: "gm", content: "gm" },
    { candidateId: "emoji", content: "🔥🔥🔥" },
    { candidateId: "bare-link", content: "https://t.co/abc https://t.co/def" },
    { candidateId: "thanks", content: "thanks @levelsio" },
  ];
  const { keep, rejected } = prefilterCandidates(items, { userWriting: [] });
  assert.deepEqual(
    keep.map((item) => item.candidateId),
    ["question", "short-question", "small-account-take", "adjacent", "short-quote", "link-plus-text"],
  );
  assert.deepEqual(new Set(rejected.map((item) => item.reason)), new Set(["low_information"]));

  // Language: only with enough of the user's own writing, and only a script they never use
  const english = Array.from({ length: 20 }, () => "I build SaaS products and write about pricing and growth.");
  const japanese = { candidateId: "ja", content: "新しいプロダクトを作りました。価格設定について皆さんはどう考えていますか" };
  const spanish = { candidateId: "es", content: "Acabamos de lanzar nuestra herramienta de precios para fundadores" };
  assert.equal(prefilterCandidates([japanese], { userWriting: english }).rejected[0]?.reason, "language_mismatch");
  assert.equal(prefilterCandidates([japanese], { userWriting: [] }).keep.length, 1, "no evidence: keep");
  assert.equal(prefilterCandidates([spanish], { userWriting: english }).keep.length, 1, "same script: keep");

  // Exact duplicates (long enough) are scored once
  const long = "Exactly the same long announcement text posted by two different accounts";
  const dupes = prefilterCandidates(
    [
      { candidateId: "a", content: long },
      { candidateId: "b", content: long },
    ],
    { userWriting: [] },
  );
  assert.deepEqual(dupes.rejected.map((item) => [item.candidate.candidateId, item.reason]), [["b", "duplicate_content"]]);
});

test("3: quote context reaches the model apart from the author's words", async () => {
  for (const strategy of ["baseline", "optimized"]) {
    process.env.SCOUT_SCORING_STRATEGY = strategy;
    ai.requests.length = 0;
    const p = await newProfile();
    const { run } = await withCandidates(p.id, 1, () =>
      withQuotedPost("Hard disagree, this is backwards", "Founders should never talk to customers before launch"),
    );
    await rankCandidates(p.id, run.id);
    const [body] = scoringRequests();
    const candidates = JSON.parse(String(body.input).split(/## Candidates \(\d+\)\n\n/)[1]);
    assert.equal(candidates[0].content, "Hard disagree, this is backwards", strategy);
    assert.equal(candidates[0].quotedPost, "Founders should never talk to customers before launch", strategy);
  }
});

test("4, 5: each profile is scored with its own brain only", async () => {
  process.env.SCOUT_SCORING_STRATEGY = "hybrid";
  const a = await newProfile();
  const b = await newProfile();
  const voice = (await getProfileById(b.id))!.voiceBrain as unknown as { data: Record<string, unknown> };
  await db
    .update(s.profilesTable)
    .set({
      voiceBrain: {
        ...voice,
        data: { ...voice.data, summary: "MARKER-B builds pottery tools" },
      } as unknown as s.Profile["voiceBrain"],
    })
    .where(eq(s.profilesTable.id, b.id));

  const runA = await withCandidates(a.id, 4);
  const runB = await withCandidates(b.id, 4);
  await rankCandidates(a.id, runA.run.id);
  const requestsA = scoringRequests().length;
  await rankCandidates(b.id, runB.run.id);
  const requests = scoringRequests();

  assert.ok(requests.slice(0, requestsA).every((body) => !String(body.input).includes("MARKER-B")), "A never sees B");
  assert.ok(requests.slice(requestsA).every((body) => String(body.input).includes("MARKER-B")), "B uses its own");
  // Every request carries only its own profile's candidates
  const idsA = new Set(runA.candidates.map((c) => c.id));
  for (const body of requests.slice(0, requestsA)) assert.ok(idsIn(body).every((id) => idsA.has(id)));
  // Separate scores per profile
  assert.ok((await candidatesOf(a.id)).every((c) => c.scoredAt));
  assert.ok((await candidatesOf(b.id)).every((c) => c.scoredAt));
});

test("6, 7: every strategy produces compatible scores; batches follow the stage", async () => {
  for (const [strategy, calls] of [
    ["optimized", 2],
    ["cheap", 2],
    ["hybrid", 4],
  ] as const) {
    process.env.SCOUT_SCORING_STRATEGY = strategy;
    ai.requests.length = 0;
    const p = await newProfile();
    const { run } = await withCandidates(p.id, 23);
    const stats = await rankCandidates(p.id, run.id);

    assert.equal(stats.strategy, strategy);
    assert.equal(stats.scored, 23, strategy);
    assert.equal(stats.calls, calls, `${strategy}: 15 per batch`);
    for (const candidate of await candidatesOf(p.id)) {
      const b = candidate.scoreBreakdown!;
      assert.ok(candidate.score! >= 0 && candidate.score! <= 100);
      for (const key of ["relevance", "goalAlignment", "expertiseFit", "freshness", "audienceValue", "novelty"] as const) {
        assert.equal(typeof b[key], "number", `${strategy} ${key}`);
      }
      assert.ok(candidate.reason && candidate.topic);
    }
    assert.ok(stats.surfaced > 0, `${strategy} still surfaces opportunities`);
    const models = scoringRequests().map((body) => String(body.model));
    if (strategy === "hybrid") {
      assert.deepEqual([...new Set(models)], [SCORING_STRATEGIES.cheap.primary.model, SCORING_STRATEGIES.optimized.primary.model]);
      assert.equal(stats.escalated, 23, "mock judgments are all promising");
    }
    for (const body of scoringRequests()) {
      assert.deepEqual(body.reasoning, { effort: "low" });
      assert.equal(body.prompt_cache_key, p.id, "one cache route per user");
      assert.equal(body.instructions, SCORING_PROMPTS.v2.instructions);
    }
  }
});

test("8, 10: a failed batch leaves its candidates pending; nothing is scored twice", async () => {
  const p = await newProfile();
  const { run } = await withCandidates(p.id, 23);
  ai.failures.push("error");
  const first = await rankCandidates(p.id, run.id);
  assert.equal(first.scored, 13);
  assert.equal(first.unscored, 10);
  assert.equal(first.failedCalls, 1);
  const scoredFirst = new Set((await candidatesOf(p.id)).filter((c) => c.scoredAt).map((c) => c.id));

  ai.requests.length = 0;
  const second = await rankCandidates(p.id, run.id);
  assert.equal(second.scored, 10);
  assert.equal(second.unscored, 0);
  const resent = scoringRequests().flatMap(idsIn);
  assert.equal(resent.length, 10);
  assert.ok(resent.every((id) => !scoredFirst.has(id)), "already scored candidates are never sent again");

  // A judgment the model leaves out stays pending too
  const q = await newProfile();
  const dropped = await withCandidates(q.id, 3);
  ai.failures.push("drop");
  assert.deepEqual(
    [(await rankCandidates(q.id, dropped.run.id)).scored, (await candidatesOf(q.id)).filter((c) => !c.scoredAt).length],
    [2, 1],
  );

  // Hybrid: a failed second stage doesn't let the cheap verdict through
  process.env.SCOUT_SCORING_STRATEGY = "hybrid";
  const h = await newProfile();
  const hybrid = await withCandidates(h.id, 5);
  ai.failures.push("drop", "error");
  const stats = await rankCandidates(h.id, hybrid.run.id);
  assert.equal(stats.scored, 0);
  assert.equal(stats.surfaced, 0);
  assert.equal((await candidatesOf(h.id)).filter((c) => !c.scoredAt).length, 5, "all retried next run");
});

test("9: an exhausted scoring budget scores nothing", async () => {
  process.env.SCOUT_SCORING_STRATEGY = "hybrid";
  const p = await newProfile();
  const { run } = await withCandidates(p.id, 5);
  const stats = await rankCandidates(p.id, run.id, { maxCandidates: 0 });
  assert.equal(stats.scored, 0);
  assert.ok(stats.skippedReason);
  assert.equal(scoringRequests().length, 0);
});

test("11: cost per model is computed from reported usage", async () => {
  const tokens = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 };
  assert.equal(estimateCostUsd("gpt-5.4-mini-2026-03-17", tokens)!.toFixed(7), ((800 * 0.75 + 200 * 0.075 + 100 * 4.5) / 1e6).toFixed(7));
  assert.equal(estimateCostUsd("gpt-5.5-2026-04-23", tokens)!.toFixed(7), ((800 * 5 + 200 * 0.5 + 100 * 30) / 1e6).toFixed(7));

  process.env.SCOUT_SCORING_STRATEGY = "cheap";
  const p = await newProfile();
  const { run } = await withCandidates(p.id, 3);
  await rankCandidates(p.id, run.id);
  const rows = await db.select().from(s.aiUsageTable).where(eq(s.aiUsageTable.scoutRunId, run.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "gpt-5.4-mini");
  // Mock usage: 1000 input, 100 output tokens
  assert.equal(rows[0].costUsd!.toFixed(6), ((1000 * 0.75 + 100 * 4.5) / 1e6).toFixed(6));
});

test("12–14: the evaluation creates nothing and reaches neither X nor Slack", async () => {
  const p = await newProfile();
  const brain = brainForRanking(resolveScoutBrain((await getProfileById(p.id))!)!);
  const dataset: EvalDataset = {
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: { "profile-1": { brain, userWriting: [], threshold: 60 } },
    examples: Array.from({ length: 6 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      profileKey: "profile-1",
      input: {
        candidateId: `00000000-0000-4000-8000-00000000000${index}`,
        authorHandle: "founder",
        kind: "post",
        hoursAgo: 1,
        replies: 3,
        content: index === 5 ? "gm" : `How do you price an AI product? Example ${index}`,
        history: [],
      },
      freshness: 15,
      postedAt: new Date().toISOString(),
      url: "https://x.com/founder/status/1",
      strata: ["medium"],
      original: {
        score: 70,
        breakdown: { relevance: 15, goalAlignment: 12, expertiseFit: 12, freshness: 15, audienceValue: 8, novelty: 8 },
        shouldEngage: true,
        reason: "r",
        suggestedAngle: "a",
        topic: "Pricing",
        surfaced: true,
        opportunityStatus: "new",
        userLabel: null,
      },
    })),
  };
  const count = async () => {
    const [row] = await db.execute<{ o: number; u: number; n: number; d: number; c: number }>(sql`
      select (select count(*) from opportunities)::int o, (select count(*) from ai_usage)::int u,
             (select count(*) from notifications)::int n, (select count(*) from notification_deliveries)::int d,
             (select count(*) from scout_candidates)::int c`).then((result) => result.rows);
    return row;
  };
  const before = await count();
  const xBefore = x.calls.length;
  const slackBefore = slack.calls.length;

  // Mock mode: no OpenAI request at all
  const mock = await runScoringEval(dataset, "hybrid");
  assert.equal(scoringRequests().length, 0);
  assert.equal(mock.mode, "mock");
  assert.equal(mock.outcomes.find((o) => o.id.endsWith("5"))?.prefiltered, "low_information");

  // Live mode (OpenAI mocked here) needs a budget and records nothing in the app
  await assert.rejects(runScoringEval(dataset, "hybrid", { mode: "live" }), EvalBudgetError);
  const live = await runScoringEval(dataset, "hybrid", { mode: "live", budgetUsd: 1 });
  assert.ok(scoringRequests().length > 0);
  assert.equal(live.outcomes.filter((o) => o.score !== null).length, 5);
  assert.ok(live.costUsd > 0);
  assert.equal(compareRun(dataset, live, mock).vsBaseline.compared, 5);

  // A budget too small for one call: nothing is sent
  ai.requests.length = 0;
  const broke = await runScoringEval(dataset, "baseline", { mode: "live", budgetUsd: 0.000001 });
  assert.equal(broke.stoppedByBudget, true);
  assert.equal(scoringRequests().length, 0);

  assert.deepEqual(await count(), before, "no opportunities, usage, notifications or candidates");
  assert.equal(x.calls.length, xBefore);
  assert.equal(slack.calls.length, slackBefore);

  // The isolation itself
  await assert.rejects(withEvalIsolation("live", () => fetch("https://api.x.com/2/users/1/tweets")), EvalIsolationError);
  await assert.rejects(withEvalIsolation("live", () => fetch("https://slack.com/api/chat.postMessage")), EvalIsolationError);
  await assert.rejects(withEvalIsolation("mock", () => fetch("https://api.openai.com/v1/responses")), EvalIsolationError);
});

test("15: malformed model output fails the batch, not the run", async () => {
  // The SDK rejects output that doesn't parse, before Scout sees its usage:
  // as before Day 20, such a call is not in ai_usage (OpenAI still bills it)
  const p = await newProfile();
  const { run, candidates } = await withCandidates(p.id, 4);
  ai.failures.push("malformed");
  const stats = await rankCandidates(p.id, run.id);
  assert.equal(stats.scored, 0);
  assert.equal(stats.failedCalls, 1);
  assert.equal(stats.unscored, 4);
  const rows = await db
    .select()
    .from(s.scoutCandidatesTable)
    .where(inArray(s.scoutCandidatesTable.id, candidates.map((c) => c.id)));
  assert.ok(rows.every((row) => row.scoredAt === null));
});

test("16: the feature flag switches strategies and rolls back", async () => {
  const p = await newProfile();
  process.env.SCOUT_SCORING_STRATEGY = "cheap";
  await rankCandidates(p.id, (await withCandidates(p.id, 2)).run.id);
  assert.equal(scoringRequests().at(-1)?.model, SCORING_STRATEGIES.cheap.primary.model);

  process.env.SCOUT_SCORING_STRATEGY = "baseline";
  await rankCandidates(p.id, (await withCandidates(p.id, 2)).run.id);
  assert.equal(scoringRequests().at(-1)?.model, BASELINE_STAGE.model);
  assert.equal(scoringRequests().at(-1)?.instructions, SCORING_PROMPTS.v1.instructions);

  process.env.SCOUT_SCORING_STRATEGY = "turbo";
  assert.equal(getScoringStrategy().id, "baseline", "unknown values fall back to baseline");
});

test("live evaluation: one shared budget, capped calls, no retries", async () => {
  const p = await newProfile();
  const brain = brainForRanking(resolveScoutBrain((await getProfileById(p.id))!)!);
  const dataset: EvalDataset = {
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: { "profile-1": { brain, userWriting: [], threshold: 60 } },
    examples: Array.from({ length: 12 }, (_, index) => {
      const id = `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
      return {
        id,
        profileKey: "profile-1",
        input: { candidateId: id, authorHandle: "founder", kind: "post", hoursAgo: 1, replies: 0, content: `How do you price AI products? ${index}`, history: [] },
        freshness: 15,
        postedAt: new Date().toISOString(),
        url: "https://x.com/founder/status/1",
        strata: ["medium"],
        original: { score: 60, breakdown: null, shouldEngage: true, reason: null, suggestedAngle: null, topic: null, surfaced: false, opportunityStatus: null, userLabel: null },
      };
    }),
  };

  // Every live request carries the hard output cap
  ai.requests.length = 0;
  const all = await runScoringEvals(dataset, ["cheap", "baseline"], { totalBudgetUsd: 2 });
  assert.equal(all.runs.length, 2);
  for (const body of scoringRequests()) {
    const batch = idsIn(body).length;
    assert.equal(body.max_output_tokens, outputCap(batch));
  }
  assert.ok(all.spentUsd <= 2);
  assert.equal(all.spentUsd.toFixed(8), all.runs.reduce((sum, run) => sum + run.costUsd, 0).toFixed(8));

  // A total too small for even one baseline call: the second strategy makes no request
  ai.requests.length = 0;
  const tight = await runScoringEvals(dataset, ["cheap", "baseline"], { totalBudgetUsd: 0.05 });
  const baselineCalls = scoringRequests().filter((body) => body.model === BASELINE_STAGE.model).length;
  assert.equal(baselineCalls, 0, "baseline never called");
  assert.ok(tight.spentUsd <= 0.05, `${tight.spentUsd}`);
  assert.equal(tight.runs[1].stoppedByBudget, true);

  // A failed call is charged at its reserved worst case (usage unknown)
  ai.failures.push("error");
  const failed = await runScoringEval(dataset, "cheap", { mode: "live", budgetUsd: 1 });
  assert.equal(failed.failedCalls, 1);
  assert.ok(failed.unaccountedUsd > 0);
  assert.ok(failed.costUsd >= failed.unaccountedUsd);

  await assert.rejects(runScoringEvals(dataset, ["cheap"], { totalBudgetUsd: 0 }), EvalBudgetError);
});

test("v3 cross-validation: no post is scored with its own label, no profile sees another's", async () => {
  const p = await newProfile();
  const brain = brainForRanking(resolveScoutBrain((await getProfileById(p.id))!)!);
  const labelsCycle = ["strong", "acceptable", "weak", "irrelevant"] as const;
  const examples: EvalDataset["examples"] = [];
  const labels: ReviewLabels = {};
  for (const profileKey of ["profile-1", "profile-2"]) {
    for (let index = 0; index < 8; index++) {
      const id = `00000000-0000-4000-8000-0000000${profileKey.endsWith("1") ? "1" : "2"}00${index}`.slice(0, 36);
      examples.push({
        id,
        profileKey,
        input: { candidateId: id, authorHandle: "founder", kind: "post", hoursAgo: 1, replies: 0, content: `MARK-${profileKey}-${index} AI coding take`, history: [] },
        freshness: 15,
        postedAt: new Date().toISOString(),
        url: "https://x.com/founder/status/1",
        strata: ["medium"],
        original: { score: 60, breakdown: null, shouldEngage: true, reason: null, suggestedAngle: null, topic: null, surfaced: false, opportunityStatus: null, userLabel: null },
      });
      labels[id] = { label: labelsCycle[index % 4] };
    }
  }
  const dataset: EvalDataset = {
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: {
      "profile-1": { brain, userWriting: [], threshold: 60 },
      "profile-2": { brain, userWriting: [], threshold: 50 },
    },
    examples,
  };

  const folds = makeFolds(dataset, labels, 2);
  assert.equal(folds.length, 4);
  for (const fold of folds) {
    assert.ok(fold.evalIds.every((id) => !fold.exampleIds.includes(id)), "held out");
    const profileOf = (id: string) => examples.find((e) => e.id === id)!.profileKey;
    assert.ok([...fold.evalIds, ...fold.exampleIds].every((id) => profileOf(id) === fold.profileKey), "one profile");
    // Every label appears in both halves
    assert.equal(new Set(fold.evalIds.map((id) => labels[id].label)).size, 4);
  }

  ai.requests.length = 0;
  const run = await runCrossValidatedV3(dataset, labels, { folds: 2, mode: "live", budgetUsd: 1 });
  assert.equal(run.outcomes.length, 16, "every rated post scored once");
  assert.equal(new Set(run.outcomes.map((o) => o.id)).size, 16);
  const requests = scoringRequests();
  assert.equal(requests.length, 4);
  for (const body of requests) {
    const input = String(body.input);
    const [examplesPart, candidatesPart] = input.split(/## Candidates \(\d+\)/);
    assert.equal(body.instructions, SCORING_PROMPTS.v3.instructions);
    assert.ok(examplesPart.includes("This user's own judgments"));
    // The candidates' own texts never appear among the examples
    for (const id of idsIn(body)) {
      const marker = examples.find((e) => e.id === id)!.input.content;
      assert.ok(candidatesPart.includes(marker));
      assert.ok(!examplesPart.includes(marker), "candidate not in its own examples");
    }
    // Examples come from the candidates' profile only
    const profile = examples.find((e) => e.id === idsIn(body)[0])!.profileKey;
    const other = profile === "profile-1" ? "profile-2" : "profile-1";
    assert.ok(!examplesPart.includes(`MARK-${other}`), "no other profile's labels");
  }
});

test("reasoning effort rolls back by configuration, without a code change", async () => {
  const p = await newProfile();
  // "default": exactly the pre-Day-21 request, no reasoning parameter
  process.env.OPENAI_SCORING_REASONING_EFFORT = "default";
  ai.requests.length = 0;
  await rankCandidates(p.id, (await withCandidates(p.id, 2)).run.id);
  assert.equal(scoringRequests().at(-1)?.reasoning, undefined);
  assert.equal(scoringRequests().at(-1)?.instructions, SCORING_PROMPTS.v1.instructions);

  process.env.OPENAI_SCORING_REASONING_EFFORT = "medium";
  await rankCandidates(p.id, (await withCandidates(p.id, 2)).run.id);
  assert.deepEqual(scoringRequests().at(-1)?.reasoning, { effort: "medium" });

  // Nonsense falls back to low, never to an invalid request
  process.env.OPENAI_SCORING_REASONING_EFFORT = "turbo";
  assert.equal(getScoringStrategy().primary.reasoningEffort, "low");
});

test("each run records the reasoning effort its requests actually sent", async () => {
  const p = await newProfile();

  // Default production configuration: low, set explicitly
  ai.requests.length = 0;
  const low = await rankCandidates(p.id, (await withCandidates(p.id, 3)).run.id);
  assert.deepEqual(low.reasoningEfforts, ["low"]);
  assert.deepEqual(scoringRequests().at(-1)?.reasoning, { effort: "low" }, "matches the request");

  // Rollback: nothing sent, recorded as the API default
  process.env.OPENAI_SCORING_REASONING_EFFORT = "default";
  ai.requests.length = 0;
  const fallback = await rankCandidates(p.id, (await withCandidates(p.id, 3)).run.id);
  assert.deepEqual(fallback.reasoningEfforts, ["default"]);
  assert.equal(scoringRequests().at(-1)?.reasoning, undefined);
});
