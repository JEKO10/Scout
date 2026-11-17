// Day 33 Growth Intelligence: metric definitions (missing stays missing),
// patterns only with enough posts, posting times, follower readings, the
// refresh (X mocked: once a day, inside the plan's X reads, deleted posts),
// the report reading stored data only, and user isolation.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getSnapshotsForProfile, saveAccountSnapshot } from "@/db/queries/growth";
import * as s from "@/db/schema";
import {
  engagement,
  engagementRate,
  findPatterns,
  type GrowthPost,
  median,
  NOT_ENOUGH_FOR_TIMES,
  overview,
  postingTimes,
  recommendations,
  replyPerformance,
  sortPosts,
} from "@/lib/growth/analyze";
import { getUsageBudget } from "@/services/billing/budget";
import { GROWTH_REFRESH_POSTS, refreshGrowthData } from "@/services/growth/collect";
import { buildGrowthReport } from "@/services/growth/report";

import { cleanup, getProfile, newProfile, rememberXUsage, trackXUser } from "./helpers/db";
import { installMocks, nextId, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

const HOUR = 3_600_000;

function post(overrides: Partial<GrowthPost> = {}): GrowthPost {
  return {
    id: nextId(),
    platformPostId: nextId(),
    url: null,
    text: "A plain statement about building products",
    publishedAt: new Date(Date.now() - 2 * 86_400_000),
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

test("definitions: missing metrics are never zero; rates only with impressions", () => {
  assert.equal(engagement(post()), 13);
  assert.equal(engagement(post({ likes: null })), null);
  assert.equal(engagementRate(post({ impressions: null })), null);
  assert.equal(engagementRate(post({ impressions: 0 })), null);
  assert.equal(engagementRate(post()), 0.013);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);

  const sorted = sortPosts([post({ impressions: null }), post({ impressions: 50 }), post({ impressions: 900 })], "rate");
  assert.equal(sorted.at(-1)!.impressions, null, "no invented rate: listed last");
  assert.equal(sortPosts([post({ impressions: null }), post({ impressions: 5 })], "impressions")[0].impressions, 5);
});

test("overview: unavailable stays unavailable; comparisons need a complete previous period", () => {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 86_400_000);
  const previousStart = new Date(start.getTime() - 30 * 86_400_000);
  const noViews = overview([post({ impressions: null }), post({ impressions: null })], [], {
    complete: false,
    previousComplete: false,
    snapshots: [],
    start,
    previousStart,
    now,
  });
  assert.equal(noViews.impressions.value, null, "not 0");
  assert.equal(noViews.engagementRate.value, null);
  assert.equal(noViews.posts.value, null, "Scout may not hold every post");
  assert.equal(noViews.followers.net, null, "no readings");

  const day = (offset: number) => new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
  const full = overview([post({ impressions: 2000 }), post({ impressions: 1000 })], [post({ impressions: 1000 })], {
    complete: true,
    previousComplete: true,
    snapshots: [
      { day: day(40), followers: 100 },
      { day: day(31), followers: 110 },
      { day: day(1), followers: 150 },
    ],
    start,
    previousStart,
    now,
  });
  assert.equal(full.impressions.value, 3000);
  assert.equal(full.impressions.change, 2);
  assert.equal(full.posts.value, 2);
  assert.equal(full.followers.current, 150);
  assert.equal(full.followers.net, 40);
  assert.equal(full.followers.previousNet, null, "no reading before the previous period");
});

test("patterns: need 10 posts and groups of 5; weak needs 8; findings carry evidence", () => {
  const questions = (n: number, impressions: number) =>
    Array.from({ length: n }, () => post({ text: "What is your pricing mistake?", impressions, likes: 30 }));
  const statements = (n: number, impressions: number) => Array.from({ length: n }, () => post({ impressions }));

  assert.deepEqual(findPatterns([...questions(4, 5000), ...statements(4, 1000)], { tz: "UTC", periodDays: 30 }), [], "too few posts");
  assert.ok(
    !findPatterns([...questions(4, 5000), ...statements(8, 1000)], { tz: "UTC", periodDays: 30 }).some((f) => f.dimension === "hook"),
    "a group of 4 is too small",
  );

  const findings = findPatterns([...questions(6, 5000), ...statements(6, 1000)], { tz: "UTC", periodDays: 30 });
  const hook = findings.find((f) => f.dimension === "hook" && f.group === "question");
  assert.ok(hook && hook.kind === "works" && hook.metric === "impressions");
  assert.equal(hook.groupN, 6);
  assert.equal(hook.totalN, 12);
  assert.match(hook.text, /400% more impressions per post \(median\)/);
  assert.equal(hook.confidence, "limited");
  assert.equal(hook.examples.length, 2);
  // Only 6 statements: not enough to call them weak
  assert.ok(!findings.some((f) => f.kind === "weak" && f.group === "statement"));

  const recs = recommendations(findings);
  assert.ok(recs[0].finding && recs[0].evidence && recs[0].action && /based on \d+ posts/.test(recs[0].confidence));
  assert.ok(recs.every((rec) => /not proof of cause/.test(rec.confidence)));

  // Replies are left out of content patterns
  assert.deepEqual(findPatterns(Array.from({ length: 20 }, () => post({ kind: "reply" })), { tz: "UTC", periodDays: 30 }), []);
});

test("posting times: no window without enough comparable posts", () => {
  const few = postingTimes(Array.from({ length: 12 }, () => post()), "UTC");
  assert.equal(few.finding, null);
  assert.ok(NOT_ENOUGH_FOR_TIMES.startsWith("Not enough historical data"));

  const at = (hour: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 3);
    date.setUTCHours(hour, 0, 0, 0);
    return date;
  };
  const many = [
    ...Array.from({ length: 15 }, () => post({ publishedAt: at(19), impressions: 4000 })),
    ...Array.from({ length: 15 }, () => post({ publishedAt: at(9), impressions: 1000 })),
  ];
  const result = postingTimes(many, "UTC");
  assert.match(result.finding ?? "", /evening/);
  assert.match(result.finding ?? "", /not a rule/);
});

test("replies: only replies X returned that answer a post opened from Scout count as verified", () => {
  const target = nextId();
  const posts = [
    post({ kind: "reply", replyToPostId: target, likes: 9 }),
    post({ kind: "reply", replyToPostId: nextId(), likes: 1 }),
    post({ kind: "post" }),
  ];
  const result = replyPerformance(posts, [target]);
  assert.equal(result.all.count, 2);
  assert.equal(result.viaScout.count, 1);
  assert.equal(result.comparable, false, "too few to compare");
});

async function connectedProfile(followers: number) {
  const p = await newProfile();
  const handle = `growth${nextId().slice(-6)}`;
  const userId = nextId();
  trackXUser(userId);
  x.users.set(handle, userId);
  x.followers.set(handle, followers);
  await db.update(s.profilesTable).set({ xHandle: handle }).where(eq(s.profilesTable.id, p.id));
  return { profile: (await getProfile(p.id))!, handle, userId };
}

function addOwnTweets(userId: string, count: number, extra: Partial<{ replyTo: string }> = {}) {
  const list = x.timelines.get(userId) ?? [];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId();
    ids.push(id);
    list.push({
      id,
      text: `My post ${id} on pricing`,
      created_at: new Date(Date.now() - (count - i) * HOUR).toISOString(),
      public_metrics: { like_count: 5, reply_count: 1, retweet_count: 1, quote_count: 1, impression_count: 500, bookmark_count: 2 },
      ...(extra.replyTo && { referenced_tweets: [{ type: "replied_to" as const, id: extra.replyTo }] }),
    });
  }
  x.timelines.set(userId, list);
  return ids;
}

test("refresh: reads the newest posts and followers once a day, counted in the plan's X reads", async () => {
  const { profile, userId } = await connectedProfile(1234);
  const replied = nextId();
  addOwnTweets(userId, 3, { replyTo: replied });
  addOwnTweets(userId, 22);

  const before = (await getUsageBudget(profile)).used.xPostReads;
  const result = await refreshGrowthData(profile);
  assert.ok(result.ok, result.message);

  const [snapshot] = await getSnapshotsForProfile(profile.id);
  assert.equal(snapshot.followers, 1234);
  assert.equal(snapshot.xPostReads, GROWTH_REFRESH_POSTS);
  assert.equal((await getUsageBudget(profile)).used.xPostReads, before + GROWTH_REFRESH_POSTS, "shares the plan's X reads");

  const stored = await db.select().from(s.postsTable).innerJoin(s.socialAccountsTable, eq(s.socialAccountsTable.id, s.postsTable.socialAccountId)).where(eq(s.socialAccountsTable.profileId, profile.id));
  assert.equal(stored.length, GROWTH_REFRESH_POSTS);
  const one = stored[0].posts;
  assert.equal(one.metricsSource, "x_api");
  assert.equal(one.metrics?.bookmarks, 2);
  assert.equal(one.metrics?.reposts, 2, "reposts include quotes");
  assert.equal(one.kind, "post");

  const again = await refreshGrowthData(profile);
  assert.equal(again.ok, false, "once a day");
  assert.match(again.message, /again in about/);
});

test("refresh: refused without enough X reads; deleted posts leave the analysis", async () => {
  const poor = await connectedProfile(10);
  await db
    .update(s.profilesTable)
    .set({ usageLimitOverrides: { monthlyXPostReads: 5, dailyPacing: false } })
    .where(eq(s.profilesTable.id, poor.profile.id));
  const calls = x.calls.length;
  const refused = await refreshGrowthData((await getProfile(poor.profile.id))!);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /X reads left/);
  assert.equal(x.calls.length, calls, "nothing sent to X");

  const { profile, userId } = await connectedProfile(50);
  const ids = addOwnTweets(userId, 10);
  assert.ok((await refreshGrowthData(profile)).ok);
  // One post deleted on X; the next refresh notices
  x.timelines.set(userId, x.timelines.get(userId)!.filter((tweet) => tweet.id !== ids[5]));
  await db.update(s.accountMetricSnapshotsTable).set({ refreshedAt: new Date(Date.now() - 25 * HOUR) }).where(eq(s.accountMetricSnapshotsTable.profileId, profile.id));
  const second = await refreshGrowthData(profile);
  assert.ok(second.ok);
  assert.match(second.message, /1 no longer on X/);

  const report = await buildGrowthReport(profile, { range: 7, tz: "UTC" });
  assert.ok("posts" in report && report.posts);
  assert.equal(report.posts.length, 9);
  assert.ok(!report.posts.some((p) => p.platformPostId === ids[5]));
});

test("report: stored data only (no X calls), follower readings, isolation", async () => {
  const { profile, userId } = await connectedProfile(300);
  addOwnTweets(userId, 6);
  assert.ok((await refreshGrowthData(profile)).ok);
  const account = (await db.select().from(s.socialAccountsTable).where(eq(s.socialAccountsTable.profileId, profile.id)))[0];
  await saveAccountSnapshot(profile.id, account.id, { followers: 280, following: null, postCount: null }, { now: new Date(Date.now() - 10 * 86_400_000) });

  const calls = x.calls.length;
  const report = await buildGrowthReport(profile, { range: 30, tz: "Europe/Belgrade" });
  assert.equal(x.calls.length, calls, "the dashboard never calls X");
  assert.ok("overview" in report && report.overview);
  assert.equal(report.posts.length, 6);
  assert.equal(report.overview.impressions.value, 3000);
  assert.equal(report.overview.followers.current, 300);
  assert.equal(report.overview.followers.net, 20);
  assert.equal(report.findings.length, 0, "6 posts: no patterns claimed");

  const other = await newProfile();
  const empty = await buildGrowthReport(other, { range: 30, tz: "UTC" });
  assert.equal(empty.account, null);
  assert.equal((await getSnapshotsForProfile(other.id)).length, 0);
  assert.equal((await refreshGrowthData(other)).ok, false, "no handle");
});
