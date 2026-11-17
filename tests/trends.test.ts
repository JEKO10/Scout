// Day 29 Trend Scout: label clustering, deduplication, momentum only with
// comparable history, sparse data, transparent scores, recompute after scans
// with no extra API calls, and user isolation. X and OpenAI are mocked; the
// database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getTrend, getTrends, setTrendSaved } from "@/db/queries/trends";
import * as s from "@/db/schema";
import { buildTrends, classifyMomentum, clusterLabels, normalizeLabel, timingFor, type TrendPost } from "@/lib/trends/detect";
import { runScout } from "@/services/scout/runScout";
import { computeTrends } from "@/services/trends/compute";
import { generateTrendInsight, insightIsStale } from "@/services/trends/insight";

import { cleanup, getProfile, newProfile, rememberXUsage, setOverrides, watch } from "./helpers/db";
import { addTweets, ai, installMocks, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

const now = new Date("2026-11-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
let n = 0;
const post = (label: string | null, author: string, postedAt: Date, extra: Partial<TrendPost> = {}): TrendPost => ({
  id: `p${n++}`,
  label,
  content: `Post ${n} about ${label} with agents and pricing`,
  authorKey: author,
  postedAt,
  score: 70,
  metrics: { likes: 10, replies: 2 },
  discoveryTopicId: null,
  reason: "You write about this often.",
  ...extra,
});
const covered = { collectingSince: hoursAgo(24 * 10), scansInCurrentWindow: 3, scansInPreviousWindow: 3 };

test("clustering: labels that say the same thing merge; broad and specific stay apart", () => {
  assert.equal(normalizeLabel("AI Coding Tools!"), "ai coding tool");
  const map = clusterLabels(["AI coding tools", "AI coding tool", "AI", "Vibe coding and AI coding tools"]);
  assert.equal(map.get("ai coding tool"), map.get(normalizeLabel("AI coding tools")));
  assert.notEqual(map.get("ai"), map.get("ai coding tool"));
});

test("momentum: growth only with comparable windows; otherwise said plainly", () => {
  assert.deepEqual(classifyMomentum(26, 8, true, hoursAgo(100), now), { status: "rising", growthPct: 225 });
  assert.equal(classifyMomentum(2, 9, true, hoursAgo(100), now).status, "declining");
  assert.equal(classifyMomentum(5, 4, true, hoursAgo(100), now).status, "stable");
  assert.deepEqual(classifyMomentum(4, 0, true, hoursAgo(10), now), { status: "emerging", growthPct: null });
  assert.deepEqual(classifyMomentum(2, 0, true, hoursAgo(10), now), { status: "newly_detected", growthPct: null });
  assert.deepEqual(classifyMomentum(26, 8, false, hoursAgo(100), now), { status: "insufficient_history", growthPct: null });
  assert.equal(classifyMomentum(3, 0, false, hoursAgo(20), now).status, "newly_detected");
});

test("trends: minimum evidence, duplicates once, generic labels out, no invented history", () => {
  const posts = [
    post("AI agents", "a", hoursAgo(2)),
    post("AI agents", "b", hoursAgo(3)),
    post("AI agent", "c", hoursAgo(5)),
    post("AI agents", "a", hoursAgo(30)),
    // A copy-paste duplicate counts once
    post("AI agents", "d", hoursAgo(4), { content: "Post 1 about AI agents with agents and pricing" }),
    // Two posts from one account: not a trend
    post("Gardening", "z", hoursAgo(2)),
    post("Gardening", "z", hoursAgo(3)),
    post("Gardening", "z", hoursAgo(4)),
    post("General", "a", hoursAgo(1)),
    post("General", "b", hoursAgo(1)),
    post("General", "c", hoursAgo(1)),
    // Irrelevant posts don't count
    post("Crypto", "a", hoursAgo(1), { score: 5 }),
    post("Crypto", "b", hoursAgo(1), { score: 5 }),
    post("Crypto", "c", hoursAgo(1), { score: 5 }),
  ];
  const trends = buildTrends(posts, covered, now);
  assert.deepEqual(trends.map((t) => t.label), ["AI agents"]);
  const [trend] = trends;
  assert.equal(trend.postCount, 4, "the duplicate counted once");
  assert.equal(trend.authorCount, 3);
  assert.equal(trend.momentum.current, 3);
  assert.equal(trend.momentum.previous, 1);
  assert.equal(trend.score, Object.values(trend.scoreBreakdown).reduce((s, v) => s + v, 0));
  assert.ok(trend.terms.includes("pricing"));

  // Collection started yesterday: no comparison, and no chart days before that
  const fresh = buildTrends(posts, { collectingSince: hoursAgo(20), scansInCurrentWindow: 2, scansInPreviousWindow: 0 }, now)[0];
  assert.equal(fresh.momentum.comparable, false);
  assert.equal(fresh.momentum.growthPct, null);
  assert.ok(fresh.dailyCounts.length <= 2, "only days Scout was collecting");
  assert.equal(fresh.scoreBreakdown.momentum, 15, "newly detected, not 'rising'");
  assert.equal(fresh.confidence, "low");
});

test("after a scan: trends from stored posts, no extra API calls, same trend keeps its ID, isolated", async () => {
  const p = await newProfile();
  const other = await newProfile();
  const users = [`t${Date.now()}a`, `t${Date.now()}b`];
  for (const user of users) addTweets(user, 2);
  await watch(p.id, users);

  await runScout(p.id);
  const trends = await getTrends(p.id, {});
  assert.equal(trends.length, 1, "the mocked scoring labels every post 'AI products'");
  assert.equal(trends[0].label, "AI products");
  assert.equal(trends[0].postCount, 4);

  const xCalls = x.calls.length;
  const aiCalls = ai.calls.length;
  await computeTrends(p.id);
  assert.equal(x.calls.length, xCalls, "no X calls");
  assert.equal(ai.calls.length, aiCalls, "no AI calls");
  const again = await getTrends(p.id, {});
  assert.equal(again[0].id, trends[0].id, "recomputed in place");

  assert.equal(await getTrend(other.id, trends[0].id), undefined, "another user can't read it");
  assert.equal((await getTrends(other.id, {})).length, 0);
});

// ---- Day 30 Trend Intelligence ----------------------------------------------

test("opportunity: relevance outweighs popularity; timing never claims more than the data", () => {
  const popular = buildTrends(
    ["a", "b", "c", "d"].map((author, i) => post("Celebrity gossip", author, hoursAgo(i + 1), { score: 25, metrics: { likes: 5000, replies: 900 } })),
    covered,
    now,
  )[0];
  const relevant = buildTrends(
    ["a", "b", "c"].map((author, i) =>
      post("Pricing for SaaS", author, hoursAgo(i + 1), { score: 85, shouldEngage: true, openOpportunity: true, metrics: { replies: 3 } }),
    ),
    covered,
    now,
  )[0];
  assert.ok(relevant.opportunityScore > popular.opportunityScore, `${relevant.opportunityScore} vs ${popular.opportunityScore}`);
  assert.equal(relevant.opportunityScore, Object.values(relevant.opportunityBreakdown).reduce((sum, v) => sum + v, 0));

  assert.equal(timingFor({ status: "emerging", comparable: true, confidence: "medium", opportunityScore: 70, hoursSinceLast: 2, openings: 2 }), "act_now");
  assert.equal(
    timingFor({ status: "emerging", comparable: true, confidence: "medium", opportunityScore: 70, hoursSinceLast: 2, openings: 0 }),
    "worth_exploring",
    "nothing to join now",
  );
  assert.equal(
    timingFor({ status: "newly_detected", comparable: false, confidence: "low", opportunityScore: 80, hoursSinceLast: 1, openings: 3 }),
    "monitor",
    "thin data: monitor",
  );
  assert.equal(timingFor({ status: "declining", comparable: true, confidence: "high", opportunityScore: 40, hoursSinceLast: 1, openings: 1 }), "low_priority");
});

async function profileWithTrend(overrides = {}) {
  const p = await newProfile(overrides);
  const users = [`i${Date.now()}${Math.random().toString(36).slice(2, 6)}a`, `i${Date.now()}${Math.random().toString(36).slice(2, 6)}b`];
  for (const user of users) addTweets(user, 2);
  await watch(p.id, users);
  await runScout(p.id);
  const [trend] = await getTrends(p.id, {});
  return { p: await getProfile(p.id), trend };
}

test("insights: on request, grounded, cached until the evidence changes, capped and locked", async () => {
  const { p, trend } = await profileWithTrend({ maxTrendInsightsPerDay: 2 });
  const other = await newProfile();
  assert.equal((await generateTrendInsight(other, trend.id)).ok, false, "not their trend");

  const calls = () => ai.calls.filter((call) => call === "trend_insight").length;
  const before = calls();
  const first = await generateTrendInsight(p, trend.id);
  assert.ok(first.ok && !first.cached);
  assert.equal(calls() - before, 1);
  if (first.ok) {
    assert.equal(first.insight.hooks.length, 3, "at most three hooks");
    assert.ok(first.insight.supportingCandidateIds.length > 0);
    assert.ok(first.insight.supportingCandidateIds.every((id) => trend.representativeCandidateIds.includes(id)), "only posts it was given");
  }

  const cached = await generateTrendInsight(p, trend.id);
  assert.ok(cached.ok && cached.cached, "no new AI call while the evidence is the same");
  assert.equal(calls() - before, 1);

  // Saved trends survive recomputes and keep their insight
  await setTrendSaved(p.id, trend.id, true);
  await computeTrends(p.id);
  const kept = await getTrend(p.id, trend.id);
  assert.ok(kept?.saved && kept.insight, "saved, insight kept");

  // Meaningfully new evidence: a refresh is allowed, then the daily cap applies
  assert.equal(insightIsStale({ ...kept!, postCount: kept!.postCount * 2 }), true);
  await db.update(s.trendsTable).set({ insightBasis: { postCount: 1, candidateIds: [] } }).where(eq(s.trendsTable.id, trend.id));
  assert.ok((await generateTrendInsight(p, trend.id)).ok);
  await db.update(s.trendsTable).set({ insightBasis: { postCount: 1, candidateIds: [] } }).where(eq(s.trendsTable.id, trend.id));
  assert.equal((await generateTrendInsight(p, trend.id)).ok, false, "two a day on this plan");
});

test("insights: one generation at a time, and none without budget", async () => {
  const busy = await profileWithTrend();
  await db.update(s.trendsTable).set({ insightLockedUntil: new Date(Date.now() + 60_000) }).where(eq(s.trendsTable.id, busy.trend.id));
  assert.equal((await generateTrendInsight(busy.p, busy.trend.id)).ok, false, "locked");

  const broke = await profileWithTrend();
  await setOverrides(broke.p.id, { monthlyScoringUsd: 0.001 });
  assert.equal((await generateTrendInsight(await getProfile(broke.p.id), broke.trend.id)).ok, false, "no budget");
});
