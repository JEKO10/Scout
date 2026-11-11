// Day 17: one X fetch per watched account, reused by every user who watches
// it; scoring, opportunities and plan usage stay per user.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq } from "drizzle-orm";

import db from "@/db";
import * as s from "@/db/schema";
import { runScout } from "@/services/scout/runScout";
import { ensureFreshPosts } from "@/services/x/sharedFetch";

import {
  ageRuns,
  cachedPostIds,
  candidateIds,
  cleanup,
  newProfile,
  rememberXUsage,
  sharedCursor,
  trackXUser,
  watch,
} from "./helpers/db";
import { addQuotedPost, addTweets, ai, installMocks, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(async () => {
  x.delayMs = 0;
  ai.shouldEngage = true;
  await cleanup();
});

let seq = 0;
const xUser = () => `s${Date.now()}${seq++}`;

async function completed(profileId: string) {
  const result = await runScout(profileId);
  if (result.status !== "completed") throw new Error(`Run ${result.status}`);
  return result;
}

async function opportunities(profileId: string) {
  return db.select().from(s.opportunitiesTable).where(eq(s.opportunitiesTable.profileId, profileId));
}

test("1, 2: two users watching one account cause one X fetch and are scored separately", async () => {
  const user = xUser();
  const posts = addTweets(user, 6);
  const [a, b] = [await newProfile(), await newProfile()];
  await watch(a.id, [user]);
  await watch(b.id, [user]);

  const calls = x.calls.length;
  const scoring = ai.calls.length;
  const runA = await completed(a.id);
  ai.shouldEngage = false; // B's Brain judges the same posts differently
  const runB = await completed(b.id);
  ai.shouldEngage = true;

  assert.equal(x.calls.length - calls, 1, "one X request for both users");
  assert.equal(runA.stats.sharedFetch?.fetched, 1);
  assert.equal(runB.stats.sharedFetch?.reused, 1);
  assert.equal(runB.stats.xApi?.requests, 0, "B caused no X usage");
  assert.deepEqual((await candidateIds(a.id)).sort(), [...posts].sort());
  assert.deepEqual((await candidateIds(b.id)).sort(), [...posts].sort());
  assert.ok(ai.calls.length - scoring >= 2, "each user scored by their own AI call");
  assert.equal((await opportunities(a.id)).length, 6, "A's Brain: worth replying");
  assert.equal((await opportunities(b.id)).length, 0, "B's Brain: not worth it");
});

test("3: one user's small budget doesn't limit another's", async () => {
  const user = xUser();
  addTweets(user, 10);
  const small = await newProfile({ monthlyXPostReads: 3 });
  const large = await newProfile();
  await watch(small.id, [user]);
  await watch(large.id, [user]);

  const runSmall = await completed(small.id);
  const runLarge = await completed(large.id);
  assert.equal(runSmall.stats.planXReads, 3, "small budget: 3 delivered");
  assert.equal(runSmall.stats.xApi?.postsReturned, 10, "the shared fetch read a full page");
  assert.equal(runLarge.stats.planXReads, 10, "the other user gets all 10");
  assert.equal(runLarge.stats.xApi?.requests, 0, "from the cache");
});

test("4: workers on separate requests don't fetch the same account twice", async () => {
  const user = xUser();
  addTweets(user, 4);
  const profiles = [await newProfile(), await newProfile(), await newProfile()];
  for (const p of profiles) await watch(p.id, [user]);

  x.delayMs = 400; // keep the first fetch in flight while the others arrive
  const calls = x.calls.length;
  const runs = await Promise.all(profiles.map((p) => completed(p.id)));
  x.delayMs = 0;

  assert.equal(x.calls.length - calls, 1, "one X request");
  assert.equal(runs.filter((run) => run.stats.sharedFetch?.fetched === 1).length, 1);
  for (const p of profiles) assert.equal((await candidateIds(p.id)).length, 4, "everyone got the posts");

  // The service directly, as three concurrent workers
  const other = xUser();
  trackXUser(other);
  addTweets(other, 2);
  x.delayMs = 400;
  const direct = await Promise.all(
    [1, 2, 3].map(() =>
      ensureFreshPosts(
        { platformUserId: other, handle: "h" },
        { firstLimit: 20, nextLimit: 10, notBefore: new Date(Date.now() - 7 * 86_400_000) },
      ),
    ),
  );
  x.delayMs = 0;
  assert.deepEqual(
    direct.map((result) => result.status).sort(),
    ["fetched", "waited", "waited"],
  );
});

test("5: a failed fetch leaves the shared cursor and releases the lock", async () => {
  const user = xUser();
  const posts = addTweets(user, 3);
  const p = await newProfile();
  await watch(p.id, [user]);
  x.failures.set(user, ["500", "500"]); // the attempt and its one retry

  const failed = await runScout(p.id);
  assert.equal(failed.status, "failed", "the only account failed");
  const [account] = await db.select().from(s.xAccountsTable).where(eq(s.xAccountsTable.platformUserId, user));
  assert.equal(account.cursor?.sinceId, "1", "cursor unchanged");
  assert.equal(account.lastFetchStatus, "failed");
  assert.equal(account.fetchLockToken, null, "lock released");
  assert.equal(account.lastFetchedAt, null, "not marked fresh");
  assert.equal((await cachedPostIds(user)).length, 0);

  await ageRuns(p.id);
  await completed(p.id);
  assert.deepEqual((await candidateIds(p.id)).sort(), [...posts].sort(), "next run fetches them");
  assert.notEqual((await sharedCursor(user))?.sinceId, "1");
});

test("6: quote context is cached and reaches every watcher without extra requests", async () => {
  const user = xUser();
  const quoted = addQuotedPost("Marketing cofounder is the new technical cofounder");
  const [quote] = addTweets(user, 1, { quoting: quoted });
  const [a, b] = [await newProfile(), await newProfile()];
  await watch(a.id, [user]);
  await watch(b.id, [user]);

  const calls = x.calls.length;
  const runA = await completed(a.id);
  const runB = await completed(b.id);
  assert.equal(x.calls.length - calls, 1, "the quoted post came in the same response");

  const [cached] = await db.select().from(s.xPostsTable).where(eq(s.xPostsTable.platformPostId, quote));
  assert.equal(cached.quotedContent, "Marketing cofounder is the new technical cofounder");
  assert.deepEqual(cached.referencedPostIds, [quoted]);
  for (const p of [a, b]) {
    const [candidate] = await db
      .select()
      .from(s.scoutCandidatesTable)
      .where(and(eq(s.scoutCandidatesTable.profileId, p.id), eq(s.scoutCandidatesTable.platformPostId, quote)));
    assert.match(candidate.content, /\[Quoted post\] Marketing cofounder/);
    assert.equal(candidate.rejectedReason, null, "not dropped for missing context");
  }
  assert.equal(runA.stats.planXReads, 2, "a quote with its quoted post counts 2");
  assert.equal(runB.stats.planXReads, 2);
});

test("7: cached posts, scored or filtered, are never delivered twice", async () => {
  const user = xUser();
  const posts = addTweets(user, 3);
  const [reply] = addTweets(user, 1, { replyTo: "1" });
  const p = await newProfile();
  await watch(p.id, [user]);

  const first = await completed(p.id);
  assert.equal(first.stats.candidates, 3);
  assert.equal(first.stats.filtered.reply, 1, "the reply is filtered by its metadata");
  const [rejected] = await db
    .select()
    .from(s.scoutCandidatesTable)
    .where(and(eq(s.scoutCandidatesTable.profileId, p.id), eq(s.scoutCandidatesTable.platformPostId, reply)));
  assert.equal(rejected.rejectedReason, "reply", "recorded as delivered and turned down");

  await ageRuns(p.id);
  const scoring = ai.calls.length;
  const second = await completed(p.id);
  assert.equal(second.stats.postsFetched, 0, "nothing delivered again");
  assert.equal(second.stats.planXReads, 0, "nothing charged again");
  assert.equal(ai.calls.length, scoring, "nothing scored again");
  assert.equal((await candidateIds(p.id)).length, posts.length + 1);
});

test("8: a user who starts watching later gets the cached posts", async () => {
  const user = xUser();
  const posts = addTweets(user, 5);
  const early = await newProfile();
  await watch(early.id, [user]);
  await completed(early.id);

  const late = await newProfile();
  await watch(late.id, [user], { cursor: false });
  const calls = x.calls.length;
  const run = await completed(late.id);
  assert.equal(x.calls.length, calls, "served from the cache");
  assert.deepEqual((await candidateIds(late.id)).sort(), [...posts].sort());
  assert.equal(run.stats.planXReads, 5);
});

test("9: partial scoring keeps the rest for later, per user", async () => {
  const user = xUser();
  addTweets(user, 8);
  const tight = await newProfile({ monthlyScoringUsd: 0.03 });
  const roomy = await newProfile();
  await watch(tight.id, [user]);
  await watch(roomy.id, [user]);

  const runTight = await completed(tight.id);
  const runRoomy = await completed(roomy.id);
  assert.equal(runTight.stats.scoring?.scored, 3, "$0.03 covers 3 at the default estimate");
  assert.equal(runTight.stats.scoring?.unscored, 5, "5 kept for later");
  assert.equal(runRoomy.stats.scoring?.scored, 8, "the other user's scoring is unaffected");
  const unscored = await db
    .select()
    .from(s.scoutCandidatesTable)
    .where(and(eq(s.scoutCandidatesTable.profileId, tight.id), eq(s.scoutCandidatesTable.source, "x_api")));
  assert.equal(unscored.filter((candidate) => candidate.scoredAt === null).length, 5);
});

test("10: a single user still gets new posts incrementally", async () => {
  const user = xUser();
  const first = addTweets(user, 4);
  const p = await newProfile();
  await watch(p.id, [user]);
  await completed(p.id);
  assert.deepEqual((await candidateIds(p.id)).sort(), [...first].sort());

  const later = addTweets(user, 3);
  // Let the shared cache go stale, as it would 15 minutes later
  await db
    .update(s.xAccountsTable)
    .set({ lastFetchedAt: new Date(Date.now() - 3600_000) })
    .where(eq(s.xAccountsTable.platformUserId, user));
  await ageRuns(p.id);
  const run = await completed(p.id);
  assert.equal(run.stats.xApi?.postsReturned, 3, "only the new posts were read from X");
  assert.equal(run.stats.candidates, 3);
  assert.deepEqual((await candidateIds(p.id)).sort(), [...first, ...later].sort());
});
