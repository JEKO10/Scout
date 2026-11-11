// Day 18: Automatic Scout scheduler. X and OpenAI are mocked. The scheduler
// claims jobs of any profile, but only test profiles ever have one: every
// real profile has Automatic Scout off.
import "./setup/env";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { GET } from "@/app/api/scheduler/route";
import db from "@/db";
import {
  deleteExpiredCachedPosts,
  deleteOldJobs,
  deleteOldRejectedCandidates,
} from "@/db/queries/cleanup";
import { getXUsageToday } from "@/db/queries/xApiUsage";
import * as s from "@/db/schema";
import { isAuthorizedSchedulerRequest } from "@/lib/scheduler/auth";
import { runSchedulerTick } from "@/services/scheduler/tick";
import { runScout } from "@/services/scout/runScout";
import { ensureFreshPosts } from "@/services/x/sharedFetch";

import {
  ageRuns,
  candidateIds,
  cleanup,
  newProfile,
  rememberXUsage,
  setOverrides,
  trackXUser,
  watch,
} from "./helpers/db";
import { addTweets, installMocks, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(async () => {
  x.delayMs = 0;
  await cleanup();
});

let seq = 0;
const xUser = () => `d${Date.now()}${seq++}`;

/** A profile with Automatic Scout on and a scan due now. */
async function autoProfile(overrides = {}) {
  const p = await newProfile(overrides);
  await db
    .update(s.profilesTable)
    .set({
      autoScanEnabled: true,
      onboardingCompleted: true,
      nextScanAt: sql`now() - interval '1 minute'`,
    })
    .where(eq(s.profilesTable.id, p.id));
  return p;
}

const tick = () => runSchedulerTick({ cleanup: false });
const profileRow = async (id: string) =>
  (await db.select().from(s.profilesTable).where(eq(s.profilesTable.id, id)))[0];
const jobsOf = (profileId: string) =>
  db.select().from(s.scanJobsTable).where(eq(s.scanJobsTable.profileId, profileId));
const runsOf = (profileId: string) =>
  db.select().from(s.scoutRunsTable).where(eq(s.scoutRunsTable.profileId, profileId));
const mine = (result: Awaited<ReturnType<typeof tick>>, profileId: string) =>
  result.outcomes.filter((outcome) => outcome.profileId === profileId);

test("1: an automatic scan runs when it's due and schedules the next one", async () => {
  const user = xUser();
  const posts = addTweets(user, 3);
  const p = await autoProfile();
  await watch(p.id, [user]);

  const result = await tick();
  assert.deepEqual(mine(result, p.id).map((o) => o.status), ["completed"]);
  assert.deepEqual((await candidateIds(p.id)).sort(), [...posts].sort());
  const [run] = await runsOf(p.id);
  assert.equal(run.trigger, "auto");
  const [job] = await jobsOf(p.id);
  assert.equal(job.status, "completed");
  assert.equal(job.scoutRunId, run.id);
  assert.ok((job.durationMs ?? -1) >= 0);
  const profile = await profileRow(p.id);
  assert.ok(profile.lastAutoScanAt, "last scan recorded");
  // Free plan default: every 120 minutes
  const minutes = (profile.nextScanAt!.getTime() - Date.now()) / 60_000;
  assert.ok(minutes > 115 && minutes <= 121, `next scan in ${minutes} min`);
});

test("2: users with Automatic Scout off are skipped", async () => {
  const user = xUser();
  addTweets(user, 2);
  const off = await newProfile();
  await db
    .update(s.profilesTable)
    .set({ onboardingCompleted: true, nextScanAt: sql`now() - interval '1 minute'` })
    .where(eq(s.profilesTable.id, off.id));
  await watch(off.id, [user]);
  const result = await tick();
  assert.equal(mine(result, off.id).length, 0);
  assert.equal((await jobsOf(off.id)).length, 0, "never queued");

  // Turned off after its job was queued: the job is skipped, nothing scanned
  const late = await autoProfile();
  await watch(late.id, [user]);
  await db.insert(s.scanJobsTable).values({ profileId: late.id });
  await db.update(s.profilesTable).set({ autoScanEnabled: false }).where(eq(s.profilesTable.id, late.id));
  const second = await tick();
  assert.deepEqual(mine(second, late.id).map((o) => o.reason), ["disabled"]);
  assert.equal((await runsOf(late.id)).length, 0);
});

test("3: concurrent schedulers never process the same user twice", async () => {
  const user = xUser();
  addTweets(user, 3);
  const p = await autoProfile();
  await watch(p.id, [user]);

  x.delayMs = 300;
  const results = await Promise.all([tick(), tick(), tick()]);
  x.delayMs = 0;
  const outcomes = results.flatMap((result) => mine(result, p.id));
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  assert.equal((await jobsOf(p.id)).length, 1, "one job");
  assert.equal((await runsOf(p.id)).length, 1, "one run");
});

test("4: automatic scans of two users share one X fetch", async () => {
  const user = xUser();
  addTweets(user, 4);
  const [a, b] = [await autoProfile(), await autoProfile()];
  await watch(a.id, [user]);
  await watch(b.id, [user]);

  const calls = x.calls.length;
  const result = await tick();
  assert.deepEqual([...mine(result, a.id), ...mine(result, b.id)].map((o) => o.status), ["completed", "completed"]);
  assert.equal(x.calls.length - calls, 1, "one X request for both");
  assert.equal((await candidateIds(a.id)).length, 4);
  assert.equal((await candidateIds(b.id)).length, 4);
});

test("5: exhausted budgets stop scans before anything costs money", async () => {
  const user = xUser();
  addTweets(user, 2);
  const p = await autoProfile({ monthlyXPostReads: 0 });
  await watch(p.id, [user]);
  const calls = x.calls.length;
  const result = await tick();
  assert.deepEqual(mine(result, p.id).map((o) => o.reason), ["budget_x_reads"]);
  assert.equal(x.calls.length, calls, "no X request");
  const next = (await profileRow(p.id)).nextScanAt!;
  assert.equal(next.getUTCDate(), 1, "retried at the start of next month");

  // The global daily X cap
  await setOverrides(p.id, {});
  await db.update(s.profilesTable).set({ nextScanAt: sql`now() - interval '1 minute'` }).where(eq(s.profilesTable.id, p.id));
  const today = await getXUsageToday();
  const day = today?.day ?? (await db.execute<{ day: string }>(sql`select (now() at time zone 'utc')::date::text as day`)).rows[0].day;
  await db
    .insert(s.xApiUsageTable)
    .values({ day, requests: 100 })
    .onConflictDoUpdate({ target: s.xApiUsageTable.day, set: { requests: 100 } });
  const capped = await tick();
  await db.update(s.xApiUsageTable).set({ requests: today?.requests ?? 0 }).where(eq(s.xApiUsageTable.day, day));
  assert.deepEqual(mine(capped, p.id).map((o) => o.reason), ["global_x_budget"]);
  assert.equal(x.calls.length, calls, "still no X request");
});

test("6: a failed job retries with backoff, then gives up", async () => {
  const user = xUser();
  const posts = addTweets(user, 2);
  const p = await autoProfile();
  await watch(p.id, [user]);
  x.failures.set(user, ["500", "500"]);

  let result = await tick();
  assert.deepEqual(mine(result, p.id).map((o) => o.status), ["retry"]);
  let [job] = await jobsOf(p.id);
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  const delay = (job.runAfter.getTime() - Date.now()) / 60_000;
  assert.ok(delay > 4 && delay <= 5.1, `first retry in ~5 min, got ${delay}`);

  // Five minutes later: X works again
  await db.update(s.scanJobsTable).set({ runAfter: sql`now()` }).where(eq(s.scanJobsTable.id, job.id));
  result = await tick();
  assert.deepEqual(mine(result, p.id).map((o) => o.status), ["completed"]);
  assert.deepEqual((await candidateIds(p.id)).sort(), [...posts].sort());

  // A job on its last attempt fails for good and the user is scheduled normally
  const other = xUser();
  addTweets(other, 1);
  const q = await autoProfile();
  await watch(q.id, [other]);
  x.failures.set(other, ["500", "500"]);
  await db.insert(s.scanJobsTable).values({ profileId: q.id, attempts: 2 });
  result = await tick();
  assert.deepEqual(mine(result, q.id).map((o) => o.status), ["failed"]);
  [job] = await jobsOf(q.id);
  assert.equal(job.status, "failed");
  assert.ok((await profileRow(q.id)).nextScanAt! > new Date(), "next regular scan scheduled");
});

test("7: expired job claims and X fetch locks recover", async () => {
  const user = xUser();
  addTweets(user, 2);
  const p = await autoProfile();
  await watch(p.id, [user]);
  // A worker died holding the job
  await db.insert(s.scanJobsTable).values({
    profileId: p.id,
    status: "running",
    attempts: 1,
    lockedBy: "dead-worker",
    lockedUntil: sql`now() - interval '1 minute'`,
  });
  const result = await tick();
  assert.ok(result.reaped >= 1);
  const [job] = await jobsOf(p.id);
  assert.equal(job.status, "pending", "back in the queue, with a short delay");
  assert.equal(job.lockedBy, null);

  // A worker died holding an X account's fetch lock
  const other = xUser();
  trackXUser(other);
  addTweets(other, 2);
  await db.insert(s.xAccountsTable).values({
    platformUserId: other,
    handle: "h",
    fetchLockToken: randomUUID(),
    fetchLockedUntil: sql`now() - interval '1 second'`,
  });
  const fetched = await ensureFreshPosts(
    { platformUserId: other, handle: "h" },
    { firstLimit: 20, nextLimit: 10, notBefore: new Date(Date.now() - 7 * 86_400_000), lockWaitMs: 0 },
  );
  assert.equal(fetched.status, "fetched", "the expired lock was taken over");

  // A live lock: the scheduler doesn't wait, it reports busy
  await db
    .update(s.xAccountsTable)
    .set({ fetchLockToken: randomUUID(), fetchLockedUntil: sql`now() + interval '2 minutes'`, lastFetchedAt: null })
    .where(eq(s.xAccountsTable.platformUserId, other));
  const started = Date.now();
  const busy = await ensureFreshPosts(
    { platformUserId: other, handle: "h" },
    { firstLimit: 20, nextLimit: 10, notBefore: new Date(Date.now() - 7 * 86_400_000), lockWaitMs: 0 },
  );
  assert.equal(busy.status, "busy");
  assert.ok(Date.now() - started < 3000, "no 20-second wait");
});

test("8: manual and automatic runs never overlap", async () => {
  const user = xUser();
  addTweets(user, 3);
  const p = await autoProfile();
  await watch(p.id, [user]);

  x.delayMs = 300;
  const [manual, scheduled] = await Promise.all([runScout(p.id), tick()]);
  x.delayMs = 0;
  const runs = await runsOf(p.id);
  assert.equal(runs.length, 1, `one run: manual ${manual.status}, auto ${JSON.stringify(mine(scheduled, p.id))}`);
  // Whichever came second backed off: the manual run, or the queued job
  if (manual.status === "completed") {
    assert.notEqual(mine(scheduled, p.id)[0]?.status, "completed");
  }
});

test("9: cleanup deletes only expired, unreferenced data", async () => {
  const user = xUser();
  const p = await newProfile();
  await watch(p.id, [user]);
  await db.insert(s.xAccountsTable).values({ platformUserId: user, handle: "h" });
  const old = new Date(Date.now() - 20 * 86_400_000);
  const post = (id: string, postedAt = old) => ({
    platformPostId: id, authorPlatformUserId: user, authorHandle: "h", content: "x", url: "u", kind: "post" as const, postedAt,
  });
  const ids = { referenced: `${user}1`, waiting: `${user}2`, expired: `${user}3`, recent: `${user}4` };
  await db.insert(s.xPostsTable).values([post(ids.referenced), post(ids.waiting), post(ids.expired), post(ids.recent, new Date())]);

  const [run] = await db.insert(s.scoutRunsTable).values({ profileId: p.id, status: "completed" }).returning();
  const [account] = await db.select().from(s.watchlistAccountsTable).where(eq(s.watchlistAccountsTable.profileId, p.id));
  await db.insert(s.opportunitiesTable).values({ scoutRunId: run.id, profileId: p.id, platform: "x", platformPostId: ids.referenced, content: "x" });
  const candidate = (id: string, extra = {}) => ({
    runId: run.id, profileId: p.id, watchlistAccountId: account.id, platform: "x" as const, platformPostId: id,
    authorHandle: "h", content: "x", url: "u", kind: "post" as const, postedAt: old, source: "x_api", ...extra,
  });
  await db.insert(s.scoutCandidatesTable).values([
    candidate(ids.waiting),
    candidate(`${user}r-old`, { rejectedReason: "reply" }),
    candidate(`${user}r-new`, { rejectedReason: "reply", postedAt: new Date() }),
  ]);
  await db.insert(s.scanJobsTable).values([
    { profileId: p.id, status: "completed", createdAt: new Date(Date.now() - 40 * 86_400_000) },
    { profileId: p.id, status: "pending", createdAt: new Date(Date.now() - 40 * 86_400_000) },
  ]);

  await deleteExpiredCachedPosts(14, 1000);
  await deleteOldRejectedCandidates(14, 1000);
  await deleteOldJobs(30, 1000);

  const cached = (await db.select().from(s.xPostsTable).where(eq(s.xPostsTable.authorPlatformUserId, user))).map((row) => row.platformPostId);
  assert.deepEqual(cached.sort(), [ids.referenced, ids.recent, ids.waiting].sort(), "only the unreferenced expired post went");
  const candidates = await candidateIds(p.id);
  assert.ok(!candidates.includes(`${user}r-old`), "old rejected delivery deleted");
  assert.ok(candidates.includes(`${user}r-new`) && candidates.includes(ids.waiting), "recent and waiting kept");
  const jobs = await jobsOf(p.id);
  assert.deepEqual(jobs.map((job) => job.status), ["pending"], "old finished job deleted, open job kept");
});

test("10: the scheduler endpoint rejects requests without the secret", async () => {
  const previous = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await GET(new Request("http://x/api/scheduler"))).status, 503, "closed without a secret");

    process.env.CRON_SECRET = "s3cret-for-tests";
    assert.equal((await GET(new Request("http://x/api/scheduler"))).status, 401);
    const wrong = new Request("http://x/api/scheduler", { headers: { authorization: "Bearer nope" } });
    assert.equal((await GET(wrong)).status, 401);
    const right = new Request("http://x/api/scheduler", { headers: { authorization: "Bearer s3cret-for-tests" } });
    assert.equal(isAuthorizedSchedulerRequest(right), true);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("11: Test Mode run limits still apply to automatic scans", async () => {
  const user = xUser();
  addTweets(user, 2);
  const p = await autoProfile();
  await watch(p.id, [user]);
  await runScout(p.id); // a manual scan a moment ago

  const result = await tick();
  assert.deepEqual(mine(result, p.id).map((o) => o.reason), ["run_limit"]);
  const [job] = await db
    .select()
    .from(s.scanJobsTable)
    .where(and(eq(s.scanJobsTable.profileId, p.id), eq(s.scanJobsTable.status, "skipped")));
  assert.equal(job.skipReason, "run_limit");
  const minutes = ((await profileRow(p.id)).nextScanAt!.getTime() - Date.now()) / 60_000;
  assert.ok(minutes > 170 && minutes <= 181, `next try when Test Mode allows: ${minutes} min`);
  assert.equal((await runsOf(p.id)).length, 1, "no second run");
  await ageRuns(p.id);
});
