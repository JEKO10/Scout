// Day 21 "Did we miss this?": selection, storage and isolation. No network.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getMissCandidates, rateMissedCandidate } from "@/db/queries/missedPosts";
import * as s from "@/db/schema";
import { MISSED_POSTS, missSampleKind, selectMissedPosts } from "@/lib/scout/missedPosts";

import { cleanup, newProfile, rememberXUsage } from "./helpers/db";
import { ai, installMocks, slack, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

const pool = (spec: [string, number, boolean, Date | null][]) =>
  spec.map(([id, score, shouldEngage, missRatedAt]) => ({ id, score, shouldEngage, missRatedAt }));

test("near-threshold vs lower-scored", () => {
  assert.equal(missSampleKind({ score: 55, shouldEngage: true }, 60), "near_threshold");
  assert.equal(missSampleKind({ score: 45, shouldEngage: true }, 60), "near_threshold");
  assert.equal(missSampleKind({ score: 72, shouldEngage: false }, 60), "near_threshold", "model said no above the threshold");
  assert.equal(missSampleKind({ score: 44, shouldEngage: true }, 60), "random_low");
});

test("three a day: two near the threshold, one random lower-scored; stable; limited", () => {
  const now = new Date("2026-11-13T10:00:00Z");
  const candidates = pool([
    ["n1", 55, true, null],
    ["n2", 58, false, null],
    ["n3", 50, true, null],
    ["l1", 20, false, null],
    ["l2", 30, false, null],
    ["l3", 10, false, null],
  ]);
  const picked = selectMissedPosts(candidates, { threshold: 60, seed: "user", now });
  assert.equal(picked.length, MISSED_POSTS.perDay);
  assert.deepEqual(picked.map((p) => p.sample), ["near_threshold", "near_threshold", "random_low"]);
  assert.deepEqual(
    selectMissedPosts(candidates, { threshold: 60, seed: "user", now }).map((p) => p.id),
    picked.map((p) => p.id),
    "a reload shows the same posts",
  );
  const tomorrow = selectMissedPosts(candidates, { threshold: 60, seed: "user", now: new Date("2026-11-14T10:00:00Z") });
  assert.equal(tomorrow.length, 3);

  // Two already rated today: one slot left; ratings from yesterday don't count
  const rated = candidates.map((c, i) =>
    i < 2 ? { ...c, missRatedAt: new Date("2026-11-13T08:00:00Z") } : i === 2 ? { ...c, missRatedAt: new Date("2026-11-12T20:00:00Z") } : c,
  );
  const left = selectMissedPosts(rated, { threshold: 60, seed: "user", now });
  assert.equal(left.length, 1);
  assert.ok(left.every((p) => !p.missRatedAt), "never re-asks a rated post");

  // One kind missing: the other fills the slots
  const onlyLow = selectMissedPosts(pool([["a", 10, false, null], ["b", 20, false, null], ["c", 5, false, null], ["d", 1, false, null]]), { threshold: 60, seed: "u", now });
  assert.deepEqual(onlyLow.map((p) => p.sample), ["random_low", "random_low", "random_low"]);
  assert.equal(selectMissedPosts([], { threshold: 60, seed: "u", now }).length, 0);
});

let seq = 0;
async function candidate(profileId: string, runId: string, values: Partial<typeof s.scoutCandidatesTable.$inferInsert>) {
  const [row] = await db
    .insert(s.scoutCandidatesTable)
    .values({
      runId,
      profileId,
      platform: "x",
      platformPostId: `m${Date.now()}${seq++}`,
      authorHandle: "founder",
      content: "A take on AI coding",
      url: "https://x.com/founder/status/1",
      kind: "post",
      postedAt: new Date(Date.now() - 3600_000),
      source: "x_api",
      score: 50,
      shouldEngage: false,
      scoredAt: new Date(),
      ...values,
    })
    .returning();
  return row;
}

test("only scored, recent, unsurfaced posts of the user; ratings stay theirs", async () => {
  const p = await newProfile();
  const other = await newProfile();
  const [run] = await db.insert(s.scoutRunsTable).values({ profileId: p.id, status: "completed" }).returning();
  const [otherRun] = await db.insert(s.scoutRunsTable).values({ profileId: other.id, status: "completed" }).returning();

  const missed = await candidate(p.id, run.id, {});
  const surfaced = await candidate(p.id, run.id, { score: 80, shouldEngage: true });
  await db.insert(s.opportunitiesTable).values({
    scoutRunId: run.id,
    profileId: p.id,
    platform: "x",
    platformPostId: surfaced.platformPostId,
    content: surfaced.content,
  });
  await candidate(p.id, run.id, { postedAt: new Date(Date.now() - 10 * 86_400_000) });
  await candidate(p.id, run.id, { scoredAt: null, score: null });
  await candidate(p.id, run.id, { rejectedReason: "low_information", scoredAt: null, score: null });
  const theirs = await candidate(other.id, otherRun.id, {});

  const startOfDay = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const found = await getMissCandidates(p.id, { days: 7, ratedSince: startOfDay });
  assert.deepEqual(found.map((row) => row.id), [missed.id], "surfaced, old, unscored and pre-filtered posts are left out");

  const before = { ai: ai.calls.length, x: x.calls.length, slack: slack.calls.length };
  assert.equal(await rateMissedCandidate(p.id, theirs.id, "strong", "near_threshold"), false, "not another user's post");
  assert.equal(await rateMissedCandidate(p.id, missed.id, "strong", "near_threshold"), true);
  const [row] = await db.select().from(s.scoutCandidatesTable).where(eq(s.scoutCandidatesTable.id, missed.id));
  assert.equal(row.missRating, "strong");
  assert.equal(row.missSample, "near_threshold");
  assert.ok(row.missRatedAt);
  assert.equal(row.userLabel, null, "Day 9 labels untouched");
  assert.equal(row.score, 50, "score untouched");
  const [theirRow] = await db.select().from(s.scoutCandidatesTable).where(eq(s.scoutCandidatesTable.id, theirs.id));
  assert.equal(theirRow.missRating, null);
  assert.deepEqual({ ai: ai.calls.length, x: x.calls.length, slack: slack.calls.length }, before, "no API calls");

  // Rated today: still returned, so it counts against today's limit
  const after = await getMissCandidates(p.id, { days: 7, ratedSince: startOfDay });
  assert.equal(after.length, 1);
  assert.equal(selectMissedPosts(after.map((r) => ({ ...r })), { threshold: 60, seed: p.id }).length, 0);
});
