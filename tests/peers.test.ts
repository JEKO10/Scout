// Day 35 Growth Strategist 2.0: Peer Intelligence and zero-to-growth plans.
// X and OpenAI are mocked. Peer observations come only from posts already in
// the shared X cache; adding a peer is one mocked X user read.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { eq, inArray } from "drizzle-orm";

import db from "@/db";
import { deletePeer, getPeerStats, listPeers, setPeerSelected } from "@/db/queries/peers";
import { getActiveStrategy } from "@/db/queries/strategy";
import * as s from "@/db/schema";
import {
  ASPIRATIONAL_FOLLOWERS,
  keywords,
  peerEvidence,
  type PeerFinding,
  peerFindings,
  type PeerStat,
  scorePeer,
  strategyStage,
  templateRoadmap,
  validateRoadmap,
} from "@/lib/strategy/peers";
import { buildEvidence, type EvidenceInput, type RawStrategy, unsupportedNumbers, validateStrategy } from "@/lib/strategy/plan";
import { addPeer, loadPeers, refreshPeer, strategyPeerEvidence } from "@/services/strategy/peers";
import { generateStrategy, loadStrategyView } from "@/services/strategy/strategist";

import { cleanup, getProfile, newProfile, rememberXUsage, setOverrides, trackXUser } from "./helpers/db";
import { ai, installMocks, nextId, x } from "./helpers/mocks";

const DAY = 86_400_000;

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(async () => {
  await cleanup();
});
beforeEach(() => {
  ai.calls.length = 0;
  ai.requests.length = 0;
  ai.strategy = null;
  x.calls.length = 0;
  delete process.env.PEER_REFRESH_ENABLED;
});

const strategyCalls = () => ai.calls.filter((c) => c === "growth_strategy").length;

// ---- Pure: comparability, patterns, evidence, stage, roadmap --------------------------

test("relevance: size decides direct vs aspirational; unknown size stays unknown", () => {
  const words = keywords("SaaS founder building onboarding tools for startups");
  const direct = scorePeer({ followers: 3_000, bio: "Founder. Building onboarding for SaaS startups.", accountCreatedAt: null }, { userFollowers: 0, userKeywords: words, peerTopicPosts: 0, postsLast30: 10 });
  assert.equal(direct.category, "direct");
  assert.ok(direct.topicSimilarity! > 0.4);
  assert.ok(direct.score >= 60);

  const big = scorePeer({ followers: 2_000_000, bio: "SaaS founder", accountCreatedAt: null }, { userFollowers: 0, userKeywords: words, peerTopicPosts: 0, postsLast30: null });
  assert.equal(big.category, "aspirational", "a celebrity-size account is never a direct peer");
  const tooBigForMe = scorePeer({ followers: 50_000, bio: null, accountCreatedAt: null }, { userFollowers: 500, userKeywords: words, peerTopicPosts: 0, postsLast30: null });
  assert.equal(tooBigForMe.category, "aspirational", "50k is over 20x a 500-follower account");
  assert.equal(scorePeer({ followers: 50_000, bio: null, accountCreatedAt: null }, { userFollowers: 5_000, userKeywords: words, peerTopicPosts: 0, postsLast30: null }).category, "direct");
  assert.ok(ASPIRATIONAL_FOLLOWERS < 2_000_000);

  const unknown = scorePeer({ followers: null, bio: null, accountCreatedAt: null }, { userFollowers: 10, userKeywords: words, peerTopicPosts: 0, postsLast30: null });
  assert.equal(unknown.category, "unknown");
  assert.equal(unknown.topicSimilarity, null, "no text: similarity unknown, not zero");
  assert.ok(unknown.reasons.some((r) => r.includes("comparability can't be judged")));
});

function stat(overrides: Partial<PeerStat>): PeerStat {
  return { postedAt: new Date(), lengthBucket: "standard", hookType: "statement", topics: [], likes: 10, replies: 2, reposts: 1, impressions: 1000, ...overrides };
}

/** 6 question posts with many replies, 8 statement posts with few, spread over `days` */
function peerPosts(days: number, { qReplies = 9, sReplies = 2 } = {}): PeerStat[] {
  const now = Date.now();
  return [
    ...Array.from({ length: 6 }, (_, i) => stat({ hookType: "question", replies: qReplies + (i % 2), postedAt: new Date(now - ((i * days) / 14) * DAY) })),
    ...Array.from({ length: 8 }, (_, i) => stat({ hookType: "statement", replies: sReplies, postedAt: new Date(now - (((i + 6) * days) / 14) * DAY) })),
  ];
}

test("peer patterns: within one account; short periods and single outliers lower confidence", () => {
  const long = peerFindings(peerPosts(40));
  const hook = long.find((f) => f.dimension === "hook" && f.metric === "replies")!;
  assert.equal(hook.group, "question");
  assert.equal(hook.direction, "higher");
  assert.equal(hook.groupN, 6);
  assert.equal(hook.confidence, "limited", "6 posts: limited by sample size");

  const short = peerFindings(peerPosts(5));
  assert.equal(short.find((f) => f.dimension === "hook" && f.metric === "replies")!.confidence, "limited");

  // Without its single best post the difference is gone: outlier-sensitive
  const outlier = [
    ...[12, 3, 3, 2, 2, 2].map((replies, i) => stat({ hookType: "question", replies, postedAt: new Date(Date.now() - i * 3 * DAY) })),
    ...Array.from({ length: 8 }, (_, i) => stat({ hookType: "statement", replies: 2, postedAt: new Date(Date.now() - (i + 6) * 3 * DAY) })),
  ];
  const found = peerFindings(outlier).find((f) => f.dimension === "hook" && f.metric === "replies")!;
  assert.equal(found.outlierSensitive, true);
  assert.equal(found.confidence, "limited");

  assert.deepEqual(peerFindings(peerPosts(40).slice(0, 8)), [], "under 10 posts: no patterns");
});

function finding(overrides: Partial<PeerFinding> = {}): PeerFinding {
  return {
    dimension: "hook", group: "question", metric: "replies", direction: "higher", groupMedian: 9, restMedian: 2, groupN: 9, restN: 12,
    first: new Date(Date.now() - 40 * DAY), last: new Date(), confidence: "moderate", outlierSensitive: false, ...overrides,
  };
}

test("peer evidence: counts independent accounts, never mixes direct and aspirational, never supports doing less", () => {
  const items = peerEvidence([
    { handle: "a", category: "direct", findings: [finding()], postsAnalyzed: 21 },
    { handle: "b", category: "direct", findings: [finding({ groupMedian: 6 })], postsAnalyzed: 20 },
    { handle: "big", category: "aspirational", findings: [finding()], postsAnalyzed: 30 },
    { handle: "thin", category: "direct", findings: [], postsAnalyzed: 4 },
  ]);
  const direct = items.find((i) => i.text.includes("direct peers"))!;
  assert.match(direct.text, /at 2 of 2 accounts with enough data/, "the account with 4 posts doesn't count");
  assert.equal(direct.confidence, "moderate", "two direct peers agree");
  assert.deepEqual(direct.peerHandles, ["a", "b"]);
  assert.match(direct.text, /not a result for you/);
  const aspirational = items.find((i) => i.text.includes("aspirational"))!;
  assert.deepEqual(aspirational.peerHandles, ["big"], "separate item: never one benchmark");
  assert.equal(aspirational.confidence, "limited");
  assert.ok(items.every((i) => i.supportsReduction === false && i.evidenceType === "peer_observation"));

  const single = peerEvidence([{ handle: "a", category: "direct", findings: [finding({ confidence: "good" })], postsAnalyzed: 40 }]);
  assert.equal(single[0].confidence, "limited", "one account is never more than limited");
});

test("stages: starting without data, learning on a short or unclear record, evidence after that", () => {
  assert.equal(strategyStage({ postsWithImpressions90: 0, span90Days: null, ownPatternConfidences: [] }), "starting");
  assert.equal(strategyStage({ postsWithImpressions90: 38, span90Days: 5, ownPatternConfidences: ["moderate"] }), "learning", "a 5-day burst");
  assert.equal(strategyStage({ postsWithImpressions90: 30, span90Days: 40, ownPatternConfidences: ["limited"] }), "learning");
  assert.equal(strategyStage({ postsWithImpressions90: 30, span90Days: 40, ownPatternConfidences: ["moderate"] }), "evidence");
});

test("roadmap: 4 weeks with measures; follower targets or wrong shapes fall back to Scout's template", () => {
  const week = (n: number, milestone = "A baseline") => ({ week: n, objective: "Post", activities: ["Write two posts"], milestone, modules: ["studio", "admin"], measure: ["Replies per post"] });
  const ok = validateRoadmap([1, 2, 3, 4].map((n) => week(n)), "starting", "find_customers");
  assert.equal(ok[0].source, "ai");
  assert.deepEqual(ok[0].modules, ["studio"], "unknown modules dropped");
  assert.equal(validateRoadmap([1, 2, 3, 4].map((n) => week(n, n === 4 ? "Reach 1,000 followers" : "x")), "starting", "find_customers")[0].source, "template");
  assert.equal(validateRoadmap([1, 2, 3, 4].map((n) => week(n, n === 2 ? "20% growth" : "x")), "starting", "grow_audience")[0].source, "template");
  assert.equal(validateRoadmap([week(1)], "learning", "grow_audience").length, 4);
  for (const stage of ["starting", "learning", "evidence"] as const) {
    const template = templateRoadmap(stage, "build_authority");
    assert.equal(template.length, 4);
    assert.ok(template.every((w) => w.measure.length > 0 && w.activities.length > 0 && !/\d+\s*followers/i.test(JSON.stringify(w))));
  }
});

function base(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    hasAccount: true, handle: "me", findings: [], postsWithImpressions90: 0, span90: null, span30: null, overview30: null, posts30: 0, postsPrevious30: null,
    replyActivity30: { opportunities: 4, generated: 2, opened: 1, confirmed: 0 }, privateMetrics: null, xConnected: false, trends: [],
    leads: { highIntentNew: 0, total: 0 }, content: { readyDrafts: 0, plannedNext7: 0, confirmedLast30: 0 }, previousSnapshot: null, ...overrides,
  };
}

function raw(overrides: Partial<RawStrategy> = {}): RawStrategy {
  return { summary: "Summary", priorities: [{ title: "P", why: "w", evidenceIds: [] }], doMore: [], toTest: [], doLess: [], tasks: [], experiments: [], experimentReviews: [], roadmap: [], ...overrides };
}

test("validation: peer ideas become hypotheses with their accounts; 'do less' never from peers; invented numbers rejected", () => {
  const evidence = buildEvidence(
    base({
      peerItems: peerEvidence([
        { handle: "a", category: "direct", findings: [finding(), finding({ group: "statement", direction: "lower", groupMedian: 2, restMedian: 9 })], postsAnalyzed: 21 },
        { handle: "b", category: "direct", findings: [finding()], postsAnalyzed: 20 },
      ]),
      profileContext: ["From your profile: SaaS founder."],
    }),
  );
  const peerIds = evidence.items.filter((i) => i.kind === "peer").map((i) => i.id);
  const profileId = evidence.items.find((i) => i.kind === "profile")!.id;
  const activityId = evidence.items.find((i) => i.kind === "activity")!.id;
  const result = validateStrategy(
    raw({
      summary: "Your account grew 340% thanks to replies.",
      priorities: [
        { title: "Open with questions", why: "Two direct peers got more replies that way.", evidenceIds: [peerIds[0]] },
        { title: "Join conversations", why: "Scout found conversations for you.", evidenceIds: [activityId] },
        { title: "Get 5,000 impressions", why: "x", evidenceIds: [activityId] },
      ],
      doMore: [
        { text: "Open more posts with a question", evidenceIds: [peerIds[0]] },
        { text: "Reply to the conversations Scout found", evidenceIds: [activityId] },
        { text: "Write about being a SaaS founder", evidenceIds: [profileId] },
      ],
      doLess: [{ text: "Stop statement openings", evidenceIds: [peerIds[1]] }],
    }),
    { evidence, weeklyMinutes: 120, activeExperiments: [] },
  )!;
  const [questions, conversations] = result.content.priorities;
  assert.equal(questions.basis, "hypothesis");
  assert.deepEqual(questions.sources, ["peer_observation"]);
  assert.deepEqual(questions.influencedBy, ["a", "b"]);
  assert.equal(conversations.basis, "evidence");
  assert.deepEqual(conversations.sources, ["scout_activity"]);
  assert.equal(result.content.priorities.length, 2, "an invented number (5,000) removes the priority");
  assert.deepEqual(result.content.doMore.map((r) => r.text), ["Reply to the conversations Scout found"]);
  assert.deepEqual(result.content.toTest!.map((r) => [r.text, r.sources]).sort(), [
    ["Open more posts with a question", ["peer_observation"]],
    ["Write about being a SaaS founder", ["profile_context"]],
  ]);
  assert.equal(result.content.doLess.length, 0, "peers alone never justify doing less");
  assert.doesNotMatch(result.content.summary, /340/, "summary with an invented number replaced");
  assert.ok(result.content.roadmap?.length === 4, "starting stage gets a roadmap");

  assert.deepEqual(unsupportedNumbers("Post 3 times, measure 12 replies", new Set()), []);
  assert.deepEqual(unsupportedNumbers("Aim for 250 replies (median 8,048)", new Set(["8048"])), ["250"]);
});

// ---- With the database: peers, cache, modes, generation ----------------------------------

/** An X account with cached posts (as if a scan read them) */
async function cachedPeerAccount(handle: string, { followers = 4_000, days = 40, posts = 14 } = {}) {
  const userId = nextId();
  x.users.set(handle.toLowerCase(), userId);
  x.followers.set(handle.toLowerCase(), followers);
  trackXUser(userId);
  await db.insert(s.xAccountsTable).values({ platformUserId: userId, handle });
  const now = Date.now();
  for (let i = 0; i < posts; i++) {
    const question = i < 6;
    await db.insert(s.xPostsTable).values({
      platformPostId: nextId(),
      authorPlatformUserId: userId,
      authorHandle: handle,
      content: question ? "Why do onboarding flows lose people at step two?" : "Onboarding is a sales problem first.",
      url: `https://x.com/${handle}/status/${i}`,
      kind: "post",
      metrics: { likes: 10, replies: question ? 9 + (i % 2) : 2, reposts: 1, impressions: 1000 },
      postedAt: new Date(now - ((i * days) / posts) * DAY),
    });
  }
  return userId;
}

test("peers: added by handle with one X read, within the plan's limit; own account and unknown handles refused", async () => {
  const p = await newProfile();
  await db.update(s.profilesTable).set({ xHandle: "meme" }).where(eq(s.profilesTable.id, p.id));
  const profile = await getProfile(p.id);
  await cachedPeerAccount("peerone");

  const added = await addPeer(profile, "peerone");
  assert.ok(added.ok);
  assert.equal(x.calls.filter((c) => c.startsWith("/2/users/by/username")).length, 1, "one user read");
  assert.equal(added.peer.followers, 4_000);
  assert.equal((await getPeerStats([added.peer.id])).get(added.peer.id)!.length, 14, "cached posts copied as numbers, no X call");
  const [row] = await db.select().from(s.peerPostStatsTable).where(eq(s.peerPostStatsTable.peerId, added.peer.id)).limit(1);
  assert.ok(!("content" in row), "no post text kept");

  assert.equal((await addPeer(profile, "meme")).ok, false, "own account");
  const missing = await addPeer(profile, "nobodyhere");
  assert.equal(missing.ok, false);
  assert.match((missing as { message: string }).message, /didn't find/);

  await setOverrides(p.id, { maxSavedPeers: 1 });
  await cachedPeerAccount("peertwo");
  const capped = await addPeer(await getProfile(p.id), "peertwo");
  assert.equal(capped.ok, false);
  assert.match((capped as { message: string }).message, /compare with 1 accounts/);
});

test("peer data is cached: opening the page reads no X; re-reading the cache doesn't duplicate", async () => {
  const p = await newProfile();
  await cachedPeerAccount("cachepeer");
  assert.ok((await addPeer(await getProfile(p.id), "cachepeer")).ok);
  x.calls.length = 0;
  const profile = await getProfile(p.id);
  const first = await loadPeers(profile, null);
  const second = await loadPeers(profile, null);
  assert.equal(x.calls.length, 0, "no X call to view or analyze peers");
  assert.equal(first[0].stats.length, 14);
  assert.equal(second[0].stats.length, 14, "upserted, not duplicated");
  assert.ok(first[0].findings.some((f) => f.dimension === "hook" && f.group === "question" && f.metric === "replies"));
});

test("peer refresh: off unless approved; when on, weekly cache, monthly count and the plan's X reads apply", async () => {
  const p = await newProfile({ maxPeerRefreshesPerMonth: 2 });
  await cachedPeerAccount("refreshpeer");
  const { peer } = (await addPeer(await getProfile(p.id), "refreshpeer")) as { ok: true; peer: s.GrowthPeer };
  x.calls.length = 0;

  const off = await refreshPeer(await getProfile(p.id), peer.id);
  assert.equal(off.ok, false);
  assert.match(off.message, /aren't enabled/);
  assert.equal(x.calls.length, 0);

  process.env.PEER_REFRESH_ENABLED = "true";
  await setOverrides(p.id, { maxPeerRefreshesPerMonth: 2, monthlyXPostReads: 10 });
  const poor = await refreshPeer(await getProfile(p.id), peer.id);
  assert.equal(poor.ok, false);
  assert.match(poor.message, /Not enough X reads/);
  assert.equal(x.calls.length, 0, "no read without budget");

  await setOverrides(p.id, { maxPeerRefreshesPerMonth: 2 });
  await db.update(s.growthPeersTable).set({ lastRefreshedAt: new Date(Date.now() - 2 * DAY) }).where(eq(s.growthPeersTable.id, peer.id));
  const recent = await refreshPeer(await getProfile(p.id), peer.id);
  assert.match(recent.message, /reuses it for 7 days/);
  assert.equal(x.calls.length, 0);
});

test("modes: 'My selected accounts' uses exactly the selected ones, says when they lack data, never substitutes", async () => {
  const p = await newProfile();
  await cachedPeerAccount("richpeer");
  await cachedPeerAccount("thinpeer", { posts: 4 });
  const profile = await getProfile(p.id);
  const rich = (await addPeer(profile, "richpeer")) as { ok: true; peer: s.GrowthPeer };
  const thin = (await addPeer(profile, "thinpeer")) as { ok: true; peer: s.GrowthPeer };
  await setPeerSelected(p.id, rich.peer.id, false);

  const peers = await loadPeers(profile, null);
  const selected = strategyPeerEvidence(peers, "selected");
  assert.deepEqual(selected.used.map((u) => u.peer.handle), ["thinpeer"]);
  assert.equal(selected.items.length, 0, "the deselected rich peer isn't used instead");
  assert.ok(selected.missing.some((m) => m.includes("@thinpeer (4)")));

  const recommended = strategyPeerEvidence(peers, "recommended");
  assert.ok(recommended.used.some((u) => u.peer.handle === "richpeer"));
  assert.ok(recommended.items.some((i) => i.peerHandles?.includes("richpeer")));
  void thin;
});

test("zero-post plan: profile context, peers as ideas, a roadmap; stage and mode saved; one AI call, no X call", async () => {
  const p = await newProfile();
  await db
    .update(s.profilesTable)
    .set({ occupation: "SaaS founder", targetAudience: "early-stage founders", onboardingCompleted: true })
    .where(eq(s.profilesTable.id, p.id));
  await cachedPeerAccount("zeropeer");
  assert.ok((await addPeer(await getProfile(p.id), "zeropeer")).ok);
  x.calls.length = 0;

  const result = await generateStrategy(await getProfile(p.id), { objective: "find_customers", weeklyMinutes: 120, peerMode: "selected" });
  assert.ok(result.ok, result.message);
  assert.equal(strategyCalls(), 1);
  assert.equal(x.calls.length, 0, "no X call to generate");
  const input = JSON.parse(String(ai.requests.at(-1)!.input));
  assert.equal(input.stage, "starting");
  assert.ok(input.evidence.some((e: { kind: string; text: string }) => e.kind === "profile" && e.text.includes("SaaS founder")));
  assert.ok(input.evidence.some((e: { kind: string; text: string }) => e.kind === "peer" && e.text.includes("@zeropeer")));
  assert.ok(!JSON.stringify(input).includes("Why do onboarding flows lose people"), "peer post text never sent: nothing to copy");

  const strategy = (await getActiveStrategy(p.id))!;
  assert.equal(strategy.stage, "starting");
  assert.equal(strategy.peerMode, "selected");
  assert.equal(strategy.content!.roadmap!.length, 4);
  assert.equal(strategy.content!.roadmap![0].source, "template", "the mock's '1,000 followers' milestone was rejected");

  const view = await loadStrategyView(await getProfile(p.id), null);
  assert.equal(view.prefs.peerMode, "selected");
  assert.equal(view.peers.length, 1);
  assert.ok(view.upToDate);
});

test("isolation: one user's peers and their numbers are invisible to another", async () => {
  const owner = await newProfile();
  const other = await newProfile();
  await cachedPeerAccount("privatepeer");
  const { peer } = (await addPeer(await getProfile(owner.id), "privatepeer")) as { ok: true; peer: s.GrowthPeer };
  assert.equal((await listPeers(other.id)).length, 0);
  assert.equal(await deletePeer(other.id, peer.id), false);
  assert.equal(await setPeerSelected(other.id, peer.id, false), false);
  assert.equal((await refreshPeer(await getProfile(other.id), peer.id)).ok, false);
  assert.equal((await loadStrategyView(await getProfile(other.id), null)).peers.length, 0);
  assert.equal(await deletePeer(owner.id, peer.id), true);
  const left = await db.select().from(s.peerPostStatsTable).where(inArray(s.peerPostStatsTable.peerId, [peer.id]));
  assert.equal(left.length, 0, "removing a peer deletes its numbers");
});
