// Day 23 cost guardrails: monthly budgets paced daily with carry-over, X
// fetches sized by what the user can afford (first scans included), and
// Free's share of Scout's global daily X caps. X and OpenAI are mocked; the
// database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getXUsageToday } from "@/db/queries/xApiUsage";
import * as s from "@/db/schema";
import { PLANS } from "@/lib/billing/plans";
import { getScoutLimits } from "@/lib/scout/testLimits";
import {
  accruedShareOfMonth,
  FREE_GLOBAL_X_SHARE,
  freeCapacityReached,
  getUsageBudget,
  PACING_UPFRONT_SHARE,
  scanBlockedBy,
} from "@/services/billing/budget";
import { planFetchCaps, runScout } from "@/services/scout/runScout";

import { cleanup, newProfile, rememberXUsage, trackXUser, watch } from "./helpers/db";
import { addTweets, installMocks, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

let seq = 0;
const xUser = () => `p${Date.now()}${seq++}`;

/** A profile on a real plan's limits (no test overrides) */
async function onPlan(plan: "free" | "starter" | "pro") {
  const p = await newProfile();
  await db.update(s.profilesTable).set({ plan, usageLimitOverrides: null }).where(eq(s.profilesTable.id, p.id));
  return (await db.select().from(s.profilesTable).where(eq(s.profilesTable.id, p.id)))[0];
}

/** Usage this month, recorded the way scans record it */
async function recordReads(profileId: string, reads: number) {
  await db.insert(s.scoutRunsTable).values({
    profileId,
    status: "completed",
    trigger: "auto",
    startedAt: new Date(),
    completedAt: new Date(),
    stats: { planXReads: reads } as s.ScoutRun["stats"],
  });
}

test("pacing: a starting share on the 1st, then a little each day", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
  assert.ok(Math.abs(accruedShareOfMonth(day(1)) - (PACING_UPFRONT_SHARE + 0.8 / 30)) < 1e-9);
  assert.ok(Math.abs(accruedShareOfMonth(day(15)) - 0.6) < 1e-9);
  assert.equal(accruedShareOfMonth(day(30)), 1);
  // Never decreasing through the month
  for (let d = 2; d <= 30; d++) assert.ok(accruedShareOfMonth(day(d)) > accruedShareOfMonth(day(d - 1)));
});

test("pacing: unused days carry over; a busy day can't take tomorrow's share", async () => {
  const p = await onPlan("starter");
  const now = new Date();
  const share = accruedShareOfMonth(now);
  const accrued = Math.floor(PLANS.starter.limits.monthlyXPostReads * share);

  let budget = await getUsageBudget(p, now);
  assert.equal(budget.remaining.xPostReads, accrued, "nothing used: everything accrued so far is available");
  assert.equal(budget.monthRemaining.xPostReads, PLANS.starter.limits.monthlyXPostReads);

  await recordReads(p.id, accrued);
  budget = await getUsageBudget(p, now);
  assert.equal(budget.remaining.xPostReads, 0);
  assert.equal(scanBlockedBy(budget), "x_reads_today", "the month has budget left, today doesn't");

  // Tomorrow, the next day's share is there (only checked when tomorrow is in this month)
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (tomorrow.getUTCMonth() === now.getUTCMonth()) {
    const next = await getUsageBudget(p, tomorrow);
    assert.ok(next.remaining.xPostReads > 0);
    assert.ok(next.remaining.xPostReads <= Math.ceil(PLANS.starter.limits.monthlyXPostReads / 25));
  }

  // Replies are on demand: not paced
  assert.equal(budget.remaining.replyUsd, PLANS.starter.limits.monthlyReplyUsd);
  // Internal accounts aren't paced
  const internal = await onPlan("starter");
  await db.update(s.profilesTable).set({ plan: "internal" }).where(eq(s.profilesTable.id, internal.id));
  assert.equal((await getUsageBudget({ ...internal, plan: "internal" }, now)).accruedShare, 1);
});

test("a run that used the whole month is blocked until next month, not tomorrow", async () => {
  const p = await onPlan("free");
  await recordReads(p.id, PLANS.free.limits.monthlyXPostReads);
  assert.equal(scanBlockedBy(await getUsageBudget(p)), "x_reads");
  assert.equal((await runScout(p.id)).status, "no_active_accounts", "nothing to scan, nothing spent");
});

test("fetch caps: spread over accounts, least recently scanned first, never above the budget", () => {
  const limits = getScoutLimits("free");
  const at = (minutes: number | null) => (minutes === null ? null : new Date(Date.now() - minutes * 60_000));
  const accounts = [
    { id: "a", lastScannedAt: at(10) },
    { id: "b", lastScannedAt: null },
    { id: "c", lastScannedAt: at(600) },
  ];
  // Quotes expanded in testing mode: a post may cost two resources
  const perPost = !limits.fetchQuotePostsWithoutContext && !limits.fetchReplies ? 2 : 1;

  const generous = planFetchCaps(accounts, 10_000, limits);
  assert.deepEqual([...generous.values()], Array(3).fill(Math.max(limits.maxPostsPerAccountFirstScan, limits.maxPostsPerAccountSubsequentScan)));

  const tight = planFetchCaps(accounts, 12 * perPost, limits);
  assert.equal(tight.get("b"), 5, "never scanned goes first");
  assert.equal(tight.get("c"), 5);
  assert.equal(tight.get("a"), 0, "scanned most recently waits");
  const total = [...tight.values()].reduce((sum, cap) => sum + cap, 0);
  assert.ok(total * perPost <= 12 * perPost, "within the budget");

  assert.deepEqual([...planFetchCaps(accounts, 0, limits).values()], [0, 0, 0]);
});

test("first scan on Free: X is asked for no more than today's budget", async () => {
  const p = await onPlan("free");
  const users = [xUser(), xUser(), xUser()];
  for (const user of users) {
    addTweets(user, 25);
    trackXUser(user);
  }
  await watch(p.id, users);
  const budget = await getUsageBudget(p);
  const before = x.calls.length;

  const result = await runScout(p.id);
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  const returned = result.stats.xApi?.postsReturned ?? 0;
  assert.ok(returned <= budget.remaining.xPostReads, `X returned ${returned}, budget ${budget.remaining.xPostReads}`);
  assert.ok((result.stats.planXReads ?? 0) <= budget.remaining.xPostReads);
  assert.ok(x.calls.length > before, "it did fetch what it could afford");
});

test("global X caps: Free stops at its share, paid plans keep going", async () => {
  const { maxXRequestsPerDay } = getScoutLimits("free");
  if (maxXRequestsPerDay === null) return; // testing mode off: no global caps to share
  const today = await getXUsageToday();
  const day = today?.day ?? new Date().toISOString().slice(0, 10);
  const freeShare = Math.ceil(maxXRequestsPerDay * FREE_GLOBAL_X_SHARE);
  await db
    .insert(s.xApiUsageTable)
    .values({ day, requests: freeShare })
    .onConflictDoUpdate({ target: s.xApiUsageTable.day, set: { requests: freeShare } });

  assert.equal(await freeCapacityReached("free"), true);
  assert.equal(await freeCapacityReached("pro"), false);
  assert.equal(await freeCapacityReached("starter"), false);

  const free = await onPlan("free");
  const user = xUser();
  addTweets(user, 3);
  trackXUser(user);
  await watch(free.id, [user]);
  const result = await runScout(free.id);
  assert.deepEqual(result, { status: "budget_exhausted", reason: "free_capacity" });
});
