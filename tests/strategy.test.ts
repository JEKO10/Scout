// Day 34 Growth Strategist: evidence from stored data only, validation of
// the AI's plan against that evidence, experiments measured from posts,
// caching, monthly allowance, AI budget, one generation at a time,
// adaptation to the previous plan, and user isolation. OpenAI is mocked;
// no X call may happen.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { and, eq } from "drizzle-orm";

import db from "@/db";
import {
  addExperimentObservation,
  getActiveStrategy,
  getExperiments,
  getPlanTasks,
  getStrategyHistory,
  insertExperiment,
  updatePlanTask,
} from "@/db/queries/strategy";
import * as s from "@/db/schema";
import type { Finding, GrowthPost } from "@/lib/growth/analyze";
import { buildEvidence, type EvidenceInput, experimentResult, planDays, type RawStrategy, validateStrategy } from "@/lib/strategy/plan";
import { generateStrategy, loadStrategyView } from "@/services/strategy/strategist";

import { cleanup, getProfile, newProfile, rememberXUsage, setOverrides } from "./helpers/db";
import { ai, installMocks, nextId, x } from "./helpers/mocks";

const DAY = 86_400_000;

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);
beforeEach(() => {
  ai.calls.length = 0;
  ai.requests.length = 0;
  ai.strategy = null;
  x.calls.length = 0;
});

const strategyCalls = () => ai.calls.filter((call) => call === "growth_strategy").length;

function baseInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    hasAccount: true,
    handle: "me",
    findings: [],
    postsWithImpressions90: 0,
    span90: null,
    span30: null,
    overview30: null,
    posts30: 2,
    postsPrevious30: null,
    replyActivity30: { opportunities: 0, generated: 0, opened: 0, confirmed: 0 },
    privateMetrics: null,
    xConnected: false,
    trends: [],
    leads: { highIntentNew: 0, total: 0 },
    content: { readyDrafts: 0, plannedNext7: 0, confirmedLast30: 0 },
    previousSnapshot: null,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    kind: "works",
    dimension: "topic",
    group: "g",
    label: "posts about onboarding",
    metric: "impressions",
    groupMedian: 900,
    restMedian: 400,
    lift: 1.25,
    groupN: 10,
    restN: 20,
    totalN: 30,
    periodDays: 90,
    confidence: "moderate",
    examples: [],
    text: "Posts about onboarding got more impressions.",
    evidence: "Median 900 vs 400.",
    action: "Write more about onboarding.",
    ...overrides,
  };
}

function post(overrides: Partial<GrowthPost>): GrowthPost {
  return {
    id: nextId(),
    platformPostId: nextId(),
    url: null,
    text: "A plain statement about building products",
    publishedAt: new Date(),
    kind: "post",
    replyToPostId: null,
    likes: 10,
    replies: 2,
    reposts: 1,
    bookmarks: null,
    impressions: 1000,
    source: "x_api",
    fetchedAt: new Date(),
    draft: null,
    topic: null,
    topicSource: null,
    ...overrides,
  };
}

test("evidence: too little history makes a labeled starter plan and says what's missing", () => {
  const evidence = buildEvidence(baseInput({ postsWithImpressions90: 3 }));
  assert.equal(evidence.mode, "starter");
  assert.ok(evidence.missing.some((text) => text.includes("Only 3 posts with impressions")));
  assert.ok(evidence.missing.some((text) => text.includes("X isn't connected")));
  assert.ok(evidence.missing.some((text) => text.includes("No follower readings")));
  assert.ok(evidence.items.every((item) => /^E\d+$/.test(item.id)));

  const quiet = buildEvidence(baseInput({ posts30: 0 }));
  assert.equal(quiet.items[0].text, "No posts in the last 30 days.", "no '0 posts, about 0.0 a week'");
  assert.equal(buildEvidence(baseInput({ posts30: 0, postsPrevious30: 4 })).items[0].text, "No posts in the last 30 days. 4 in the 30 days before.");
  assert.match(buildEvidence(baseInput({ posts30: 9 })).items[0].text, /^You published 9 posts/);

  const none = buildEvidence(baseInput({ hasAccount: false, posts30: 0 }));
  assert.ok(none.missing[0].startsWith("No X account synced"));
});

test("evidence: only a weak pattern over 8+ posts with more than limited confidence supports doing less", () => {
  const evidence = buildEvidence(
    baseInput({
      postsWithImpressions90: 30,
      findings: [
        finding({}),
        finding({ kind: "weak", dimension: "hook", metric: "replies", label: "question-hook", groupN: 3, confidence: "limited" }),
        finding({ kind: "weak", dimension: "time", label: "morning (5–12h)", groupN: 12, confidence: "moderate" }),
      ],
    }),
  );
  assert.equal(evidence.mode, "evidence");
  const [works, fewWeak, strongWeak] = evidence.items;
  assert.equal(works.kind, "works");
  assert.equal(works.supportsReduction, false);
  assert.equal(fewWeak.supportsReduction, false, "3 posts never justify doing less");
  assert.equal(strongWeak.supportsReduction, true);
  assert.equal(strongWeak.sampleSize, 30);
  assert.equal(strongWeak.metric, "impressions");
});

test("evidence: two sides of one comparison are merged; different metrics stay separate", () => {
  const evidence = buildEvidence(
    baseInput({
      postsWithImpressions90: 38,
      findings: [
        finding({ kind: "works", dimension: "length", metric: "replies", label: "standard-length (101–280 characters)", groupMedian: 41, restMedian: 2, groupN: 8, restN: 30, confidence: "moderate" }),
        finding({ kind: "weak", dimension: "length", metric: "replies", label: "short (up to 100 characters)", groupMedian: 1.5, restMedian: 41, groupN: 28, restN: 10, confidence: "good" }),
        finding({ kind: "works", dimension: "length", metric: "impressions", label: "long (over 280 characters)", groupMedian: 900, restMedian: 400, groupN: 6, restN: 32, confidence: "limited" }),
      ],
    }),
  );
  const patterns = evidence.items.filter((item) => item.source === "growth" && item.metric);
  assert.equal(patterns.length, 2, "replies (merged) + impressions (kept apart)");
  const [replies, impressions] = patterns;
  assert.equal(replies.kind, "comparison");
  assert.equal(replies.metric, "replies");
  assert.match(replies.text, /^Post length, replies per post: standard-length .* median 41 vs 2 .*; short .* median 1\.5 vs 41/);
  assert.match(replies.text, /One comparison seen from 2 sides/);
  assert.equal(replies.confidence, "moderate", "the weaker side's confidence");
  assert.equal(replies.supportsReduction, true, "the weak side has 28 posts");
  assert.equal(impressions.kind, "works");
  assert.equal(impressions.metric, "impressions");
});

test("evidence: the real period is stated; under 21 days confidence drops and no weekly average is shown", () => {
  const first = new Date("2026-10-18T10:00:00Z");
  const last = new Date("2026-10-22T18:00:00Z");
  const evidence = buildEvidence(
    baseInput({
      postsWithImpressions90: 38,
      span90: { first, last },
      span30: { first, last },
      posts30: 37,
      findings: [
        finding({ kind: "works", dimension: "time", label: "afternoon (12–17h)", confidence: "moderate" }),
        finding({ kind: "weak", dimension: "hook", metric: "replies", label: "statement-hook", groupN: 12, confidence: "good" }),
      ],
    }),
  );
  const [afternoon, statement] = evidence.items;
  assert.equal(afternoon.confidence, "limited", "moderate → limited over 5 days");
  assert.equal(statement.confidence, "moderate", "good → moderate");
  assert.equal(statement.supportsReduction, true);
  for (const item of evidence.items) assert.doesNotMatch(item.text, /90 days/);
  assert.match(afternoon.text, /Based on 38 posts from Oct 18 to Oct 22 \(5 days\)\./);
  const cadence = evidence.items.find((item) => item.text.startsWith("You published"))!;
  assert.match(cadence.text, /all between Oct 18 and Oct 22 \(5 days\): too short a stretch for a weekly average/);
  assert.doesNotMatch(cadence.text, /about [\d.]+ a week/);
  assert.ok(evidence.missing.some((text) => text.startsWith("Your analyzed posts cover only 5 days (Oct 18–Oct 22)")));

  const spread = buildEvidence(
    baseInput({ posts30: 9, postsPrevious30: 4, span30: { first: new Date("2026-10-01T00:00:00Z"), last: new Date("2026-10-28T00:00:00Z") } }),
  );
  assert.equal(spread.items[0].text, "You published 9 posts (replies included) in the last 30 days, about 2.1 a week. 4 in the 30 days before.");
  assert.equal(buildEvidence(baseInput({ posts30: 0, postsPrevious30: 0 })).items[0].text, "No posts in the last 30 days. None in the 30 days before either.");
});

test("evidence: changes since the last plan are computed, not written by the AI", () => {
  const evidence = buildEvidence(
    baseInput({
      posts30: 9,
      previousSnapshot: { postsLast30: 4, postsPrevious30: null, medianImpressions: 500, engagementRate: 0.01, followers: 100, repliesOpened: 1 },
      overview30: {
        medianImpressions: 750,
        postsWithImpressions: 9,
        engagementRate: { value: 0.02, previous: null, change: null },
        followers: { current: 130, net: 30, growth: 0.3, previousNet: null, since: "2026-11-01" },
      } as unknown as EvidenceInput["overview30"],
    }),
  );
  assert.deepEqual(evidence.changes, [
    "Posts in the last 30 days: 4 → 9.",
    "Median impressions per post: 500 → 750 (+50%).",
    "Engagement rate: 1.00% → 2.00%.",
    "Followers: 100 → 130 (+30).",
    "Replies opened on X (30 days): 1 → 0.",
  ]);
});

function raw(overrides: Partial<RawStrategy> = {}): RawStrategy {
  return {
    summary: "Summary",
    priorities: [{ title: "P1", why: "w", evidenceIds: ["E1"] }],
    doMore: [],
    toTest: [],
    doLess: [],
    tasks: [],
    experiments: [],
    experimentReviews: [],
    ...overrides,
  };
}

test("validation: unknown evidence, unsupported advice, follower claims and unmeasured experiments are removed", () => {
  const evidence = buildEvidence(
    baseInput({
      postsWithImpressions90: 30,
      findings: [
        finding({}),
        finding({ kind: "weak", dimension: "hook", metric: "replies", label: "question-hook", groupN: 3, confidence: "limited" }),
        finding({ kind: "weak", dimension: "time", label: "morning (5–12h)", groupN: 12, confidence: "good" }),
        finding({ kind: "works", dimension: "length", metric: "replies", label: "long (over 280 characters)", groupN: 5, confidence: "limited" }),
      ],
    }),
  );
  // E1 topic (moderate), E2 hook (limited, weak), E3 time (good, weak), E4 length (limited, works)
  const result = validateStrategy(
    raw({
      priorities: [
        { title: "Cites real evidence", why: "w", evidenceIds: ["E1", "E99"] },
        { title: "Cites nothing real", why: "w", evidenceIds: ["E99"] },
        { title: "Try longer posts", why: "Long posts did better on replies.", evidenceIds: ["E4"] },
      ],
      doMore: [
        { text: "Backed by a moderate pattern", evidenceIds: ["E1"] },
        { text: "Only a limited pattern", evidenceIds: ["E4"] },
        { text: "Unbacked", evidenceIds: [] },
        { text: "These posts grew your followers", evidenceIds: ["E1"] },
      ],
      doLess: [
        { text: "Few posts only", evidenceIds: ["E2"] },
        { text: "Strong weak pattern", evidenceIds: ["E3"] },
      ],
      experiments: [
        { title: "ok", hypothesis: "h", dimension: "hook", variantA: "question", variantB: "statement", metric: "replies", durationDays: 7, actions: ["a"] },
        { title: "bad variant", hypothesis: "h", dimension: "length", variantA: "tiny", variantB: "long", metric: "impressions", durationDays: 14, actions: [] },
        { title: "already running", hypothesis: "h", dimension: "time", variantA: "morning", variantB: "evening", metric: "impressions", durationDays: 14, actions: [] },
      ],
      experimentReviews: [
        { experimentId: "running-1", recommendation: "stop", reason: "r" },
        { experimentId: "someone-elses", recommendation: "stop", reason: "r" },
      ],
    }),
    { evidence, weeklyMinutes: 120, activeExperiments: [{ id: "running-1", dimension: "time", variantA: "morning", variantB: "evening" }] },
  )!;

  assert.deepEqual(result.content.priorities.map((p) => [p.title, p.basis]), [
    ["Cites real evidence", "evidence"],
    ["Try longer posts", "hypothesis"],
  ]);
  assert.deepEqual(result.content.priorities[0].evidenceIds, ["E1"], "invented IDs dropped");
  assert.deepEqual(result.content.priorities[0].measuredBy, ["impressions per post"]);
  assert.deepEqual(result.content.doMore.map((r) => r.text), ["Backed by a moderate pattern"], "no follower claim without follower evidence");
  assert.deepEqual(result.content.toTest!.map((r) => [r.text, r.measuredBy]), [["Only a limited pattern", ["replies per post"]]], "limited → worth testing");
  assert.deepEqual(result.content.doLess.map((r) => r.text), ["Strong weak pattern"]);
  assert.deepEqual(result.experiments.map((e) => [e.title, e.durationDays]), [["ok", 14]], "at least 14 days");
  assert.deepEqual(result.content.experimentReviews.map((r) => r.experimentId), ["running-1"]);

  assert.equal(validateStrategy(raw({ priorities: [{ title: "x", why: "y", evidenceIds: ["E99"] }] }), { evidence, weeklyMinutes: 120, activeExperiments: [] }), null, "nothing cited: no plan");
});

test("tasks: spread over the week within daily and weekly time, never cut from the end", () => {
  const evidence = buildEvidence(baseInput({ postsWithImpressions90: 2 }));
  const task = (day: number, effortMinutes: number, title: string) => ({ day, title, objective: "o", activity: "a", reason: "r", effortMinutes, module: "studio", evidenceIds: [] });
  // What the real model proposed for @marclou: 11 tasks, 235 minutes, front-loaded
  const proposed = [
    task(0, 35, "d0a"), task(0, 10, "d0b"), task(1, 25, "d1a"), task(1, 20, "d1b"), task(2, 25, "d2a"), task(2, 20, "d2b"),
    task(3, 20, "d3a"), task(3, 10, "d3b"), task(4, 25, "d4a"), task(5, 20, "d5a"), task(6, 25, "d6a"), task(0, 5, "d0c third"),
  ];
  const { tasks } = validateStrategy(raw({ priorities: [{ title: "p", why: "w", evidenceIds: [] }], tasks: proposed }), { evidence, weeklyMinutes: 180, activeExperiments: [] })!;
  const days = new Set(tasks.map((t) => t.day));
  assert.deepEqual([...days].sort(), [0, 1, 2, 3, 4, 5, 6], "every day that had a task keeps one");
  assert.ok(tasks.reduce((sum, t) => sum + t.effortMinutes, 0) <= 180);
  for (const d of days) {
    const today = tasks.filter((t) => t.day === d);
    assert.ok(today.length <= 2);
    assert.ok(today.reduce((sum, t) => sum + t.effortMinutes, 0) <= 60, "at most a third of the week a day");
    assert.deepEqual(today.map((t) => t.position), today.map((_, i) => i + 1));
  }
  assert.ok(!tasks.some((t) => t.title === "d0c third"));

  // Rest days stay rest days; a heavy day is capped
  const sparse = validateStrategy(
    raw({ priorities: [{ title: "p", why: "w", evidenceIds: [] }], tasks: [task(0, 50, "a"), task(0, 30, "b"), task(3, 20, "c")] }),
    { evidence, weeklyMinutes: 60, activeExperiments: [] },
  )!.tasks;
  assert.deepEqual(sparse.map((t) => [t.day, t.title, t.position]), [[0, "b", 1], [3, "c", 1]], "the 50-min task can't fit a 30-min day; nothing moved onto rest days");
});

test("validation: a starter plan may have uncited priorities but never 'do less'", () => {
  const evidence = buildEvidence(baseInput({ postsWithImpressions90: 2 }));
  const result = validateStrategy(
    raw({ priorities: [{ title: "Build a baseline", why: "w", evidenceIds: [] }], doLess: [{ text: "x", evidenceIds: ["E1"] }] }),
    { evidence, weeklyMinutes: 60, activeExperiments: [] },
  )!;
  assert.equal(result.content.priorities.length, 1);
  assert.equal(result.content.doLess.length, 0);
});

test("experiments: compared only with enough posts per variant, always as directional", () => {
  const start = new Date(Date.now() - 10 * DAY);
  const exp = { dimension: "hook", variantA: "question", variantB: "statement", metric: "replies", minPerVariant: 5, startedAt: start, endsAt: new Date(Date.now() + DAY) };
  const questions = Array.from({ length: 5 }, (_, i) => post({ text: "Why do launches fail?", replies: 6 + i, publishedAt: new Date(Date.now() - DAY) }));
  const statements = Array.from({ length: 4 }, () => post({ text: "Launches fail.", replies: 2, publishedAt: new Date(Date.now() - DAY) }));
  const before = post({ text: "Launches fail.", replies: 2, publishedAt: new Date(start.getTime() - DAY) });

  const collecting = experimentResult(exp, [...questions, ...statements, before], { tz: "UTC" });
  assert.deepEqual(collecting, { status: "collecting", aN: 5, bN: 4, needed: 5 }, "posts from before the start don't count");

  const result = experimentResult(exp, [...questions, ...statements, post({ text: "Launches fail.", replies: 2, publishedAt: new Date() })], { tz: "UTC" });
  assert.equal(result.status, "directional");
  if (result.status === "directional") {
    assert.equal(result.aMedian, 8);
    assert.equal(result.bMedian, 2);
    assert.equal(result.confidence, "limited");
    assert.match(result.note, /can't show a statistically significant difference/);
  }
  assert.equal(experimentResult({ ...exp, dimension: "custom" }, questions, { tz: "UTC" }).status, "manual");
  assert.equal(experimentResult({ ...exp, startedAt: null }, questions, { tz: "UTC" }).status, "not_started");
});

test("generate: starter plan from stored data, validated, saved with tasks; no X call", async () => {
  const p = await newProfile();
  const profile = await getProfile(p.id);
  const result = await generateStrategy(profile, { objective: "find_customers", weeklyMinutes: 120 });
  assert.ok(result.ok, result.message);
  assert.equal(strategyCalls(), 1);
  assert.equal(x.calls.length, 0, "a strategy never reads X");

  const request = ai.requests.find((r) => (r as { text?: { format?: { name?: string } } }).text?.format?.name === "growth_strategy")!;
  const input = JSON.parse(String(request.input));
  assert.equal(input.mode, "starter");
  assert.equal(input.user.objective, "Find customers");
  assert.ok(input.missingData.length > 0, "the AI is told what is missing");
  assert.equal(request.max_output_tokens, 6000, "output capped");

  const active = (await getActiveStrategy(p.id))!;
  assert.equal(active.mode, "starter");
  assert.ok(active.content!.priorities.length >= 1);
  assert.equal(active.content!.doLess.length, 0, "a starter plan never says 'do less'");
  assert.ok(active.content!.priorities.every((pr) => !pr.evidenceIds.includes("E99")));
  const tasks = await getPlanTasks(p.id, active.id);
  assert.ok(tasks.reduce((sum, t) => sum + t.effortMinutes, 0) <= 120, "fits the weekly time");
  assert.ok(tasks.every((t) => t.module !== "admin"));
  const days = planDays(active.weekStart);
  assert.ok(tasks.every((t) => days.includes(t.day)));
  const proposed = (await getExperiments(p.id)).filter((e) => e.status === "proposed");
  assert.deepEqual(proposed.map((e) => e.title), ["Question vs statement"], "unmeasurable variant dropped");
});

test("generate: cached while nothing changed; new settings regenerate; previous plan becomes history", async () => {
  const p = await newProfile();
  const profile = await getProfile(p.id);
  assert.ok((await generateStrategy(profile, { objective: "build_authority", weeklyMinutes: 60 })).ok);
  const first = (await getActiveStrategy(p.id))!;
  await updatePlanTask(p.id, (await getPlanTasks(p.id, first.id))[0].id, { status: "done" });

  const again = await generateStrategy(profile, { objective: "build_authority", weeklyMinutes: 60 });
  assert.ok(again.ok && again.cached);
  assert.equal(strategyCalls(), 1, "no second AI call for the same evidence");

  assert.ok((await generateStrategy(profile, { objective: "build_authority", weeklyMinutes: 180 })).ok);
  assert.equal(strategyCalls(), 2);
  const request = JSON.parse(String(ai.requests.at(-1)!.input));
  assert.deepEqual(request.previousPlan.tasks, { total: (await getPlanTasks(p.id, first.id)).length, done: 1, skipped: 0 }, "adapts to how the last plan went");

  const history = await getStrategyHistory(p.id);
  assert.deepEqual(history.map((h) => h.status), ["active", "archived"]);
  assert.equal(history[1].done, 1);
  assert.ok(history[1].tasks > 1, "task totals per plan");
});

test("generate: monthly allowance and the AI budget are enforced before any AI call", async () => {
  const capped = await newProfile({ maxStrategyGenerationsPerMonth: 1 });
  assert.ok((await generateStrategy(await getProfile(capped.id), { objective: "grow_audience", weeklyMinutes: 60 })).ok);
  const second = await generateStrategy(await getProfile(capped.id), { objective: "grow_audience", weeklyMinutes: 300 });
  assert.equal(second.ok, false);
  assert.match(second.message, /1 strategy update a month/);
  assert.equal(strategyCalls(), 1);

  const poor = await newProfile({ monthlyScoringUsd: 0.05 });
  const refused = await generateStrategy(await getProfile(poor.id), { objective: "grow_audience", weeklyMinutes: 60 });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /AI budget/);
  assert.equal(strategyCalls(), 1, "no call without budget");
});

test("generate: two at once make one AI call", async () => {
  const p = await newProfile();
  const profile = await getProfile(p.id);
  const results = await Promise.all([
    generateStrategy(profile, { objective: "generate_leads", weeklyMinutes: 120 }),
    generateStrategy(profile, { objective: "generate_leads", weeklyMinutes: 120 }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.match(results.find((r) => !r.ok)!.message, /already being written/);
  assert.equal(strategyCalls(), 1);
});

test("generate: output with nothing usable fails cleanly and keeps no plan", async () => {
  const p = await newProfile();
  ai.strategy = () => ({ summary: "x", priorities: [], doMore: [], toTest: [], doLess: [], tasks: [], experiments: [], experimentReviews: [] });
  const result = await generateStrategy(await getProfile(p.id), { objective: "grow_audience", weeklyMinutes: 60 });
  assert.equal(result.ok, false);
  assert.equal(await getActiveStrategy(p.id), undefined);
  const [row] = await db.select().from(s.growthStrategiesTable).where(eq(s.growthStrategiesTable.profileId, p.id));
  assert.equal(row.status, "failed");
});

test("evidence mode: real posts with impressions; running experiments get reviewed; numbers on the page are Scout's", async () => {
  const p = await newProfile();
  await db.update(s.profilesTable).set({ xHandle: "evidenceuser" }).where(eq(s.profilesTable.id, p.id));
  const [account] = await db.insert(s.socialAccountsTable).values({ profileId: p.id, platform: "x", platformUserId: nextId(), handle: "evidenceuser" }).returning();
  for (let i = 0; i < 12; i++) {
    await db.insert(s.postsTable).values({
      socialAccountId: account.id,
      platformPostId: nextId(),
      content: i % 2 ? "Why do onboarding flows fail?" : "Onboarding is a sales problem.",
      publishedAt: new Date(Date.now() - (i + 1) * 2 * DAY),
      kind: "post",
      metrics: { likes: 5 + i, replies: i % 2 ? 6 : 1, reposts: 1, impressions: 400 + i * 50 },
      metricsSource: "x_api",
    });
  }
  const running = await insertExperiment(p.id, {
    title: "Hooks",
    hypothesis: "Questions get more replies",
    dimension: "hook",
    variantA: "question",
    variantB: "statement",
    metric: "replies",
    durationDays: 30,
    minPerVariant: 5,
    actions: [],
    status: "active",
    startedAt: new Date(Date.now() - 29 * DAY),
    endsAt: new Date(Date.now() + DAY),
  });
  const profile = await getProfile(p.id);
  assert.ok((await generateStrategy(profile, { objective: "build_authority", weeklyMinutes: 120 })).ok);
  const input = JSON.parse(String(ai.requests.at(-1)!.input));
  assert.equal(input.mode, "evidence");
  assert.equal(input.runningExperiments[0].id, running.id);
  assert.equal(input.runningExperiments[0].result.status, "directional");

  const view = await loadStrategyView(profile, null);
  assert.equal(view.evidence.snapshot.postsLast30, 12, "posts of the last 30 days, counted by Scout");
  assert.equal(view.strategy!.content!.experimentReviews[0].experimentId, running.id);
  assert.ok(view.upToDate);
});

test("isolation: another user can't change, read or annotate someone else's plan", async () => {
  const owner = await newProfile();
  const intruder = await newProfile();
  assert.ok((await generateStrategy(await getProfile(owner.id), { objective: "grow_audience", weeklyMinutes: 60 })).ok);
  const strategy = (await getActiveStrategy(owner.id))!;
  const [task] = await getPlanTasks(owner.id, strategy.id);
  assert.equal(await updatePlanTask(intruder.id, task.id, { status: "done" }), false);
  assert.equal((await getPlanTasks(intruder.id, strategy.id)).length, 0);
  const [experiment] = await getExperiments(owner.id);
  assert.equal(await addExperimentObservation(intruder.id, experiment.id, { at: new Date().toISOString(), text: "hi" }), false);
  assert.ok(await addExperimentObservation(owner.id, experiment.id, { at: new Date().toISOString(), text: "first" }));
  const [after] = await db.select().from(s.growthExperimentsTable).where(and(eq(s.growthExperimentsTable.id, experiment.id)));
  assert.deepEqual(after.observations.map((o) => o.text), ["first"]);
  assert.equal((await loadStrategyView(await getProfile(intruder.id), strategy.id)).strategy, null, "can't open it by ID");
  await setOverrides(owner.id, {});
});
