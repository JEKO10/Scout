// Day 16: per-user budgets, cursor correctness and duplicate runs.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq } from "drizzle-orm";

import db from "@/db";
import * as s from "@/db/schema";
import { getRunAnalytics } from "@/services/analytics/runAnalytics";
import { getUsageBudget, scoringAllowance } from "@/services/billing/budget";
import { generateReplies } from "@/services/replies/generateReply";
import { runScout } from "@/services/scout/runScout";

import {
  ageRuns,
  candidateIds,
  cleanup,
  getProfile,
  newProfile,
  rememberXUsage,
  setOverrides,
  watch,
  watchedCursor,
} from "./helpers/db";
import { addTweets, ai, installMocks, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

test("an exhausted X or scoring budget refuses the scan: no run, no X request", async () => {
  const p = await newProfile({ monthlyXPostReads: 0 });
  const user = `g1${Date.now()}`;
  addTweets(user, 3);
  await watch(p.id, [user]);
  const calls = x.calls.length;

  assert.deepEqual(await runScout(p.id), { status: "budget_exhausted", reason: "x_reads" });
  await setOverrides(p.id, { monthlyScoringUsd: 0 });
  assert.deepEqual(await runScout(p.id), { status: "budget_exhausted", reason: "scoring" });

  assert.equal(x.calls.length, calls, "no X request");
  const runs = await db.select().from(s.scoutRunsTable).where(eq(s.scoutRunsTable.profileId, p.id));
  assert.equal(runs.length, 0, "no run row");
});

test("the read budget stops mid-scan without skipping posts", async () => {
  const p = await newProfile({ monthlyXPostReads: 12 });
  const users = ["a", "b", "c"].map((name) => `g2${name}${Date.now()}`);
  const posts = users.flatMap((user) => addTweets(user, 10));
  await watch(p.id, users);

  let r = await runScout(p.id);
  if (r.status !== "completed") throw new Error(r.status);
  assert.match(r.stats.xApi?.stoppedReason ?? "", /Monthly X read budget/);
  assert.ok((r.stats.xApi?.postsReturned ?? 0) <= 12, `never over budget: ${r.stats.xApi?.postsReturned}`);
  assert.equal((await watchedCursor(p.id, users[2]))?.sinceId, "1", "unread account keeps its cursor");

  await setOverrides(p.id, { monthlyXPostReads: 1000 });
  await ageRuns(p.id);
  r = await runScout(p.id);
  if (r.status !== "completed") throw new Error(r.status);
  const ids = await candidateIds(p.id);
  for (const id of posts) assert.ok(ids.includes(id), `post ${id} processed`);
  assert.equal(ids.length, new Set(ids).size, "no duplicates");
  assert.equal(r.stats.filtered.already_seen, 0, "nothing reread");
});

test("partial scoring keeps the rest unscored, then scores them", async () => {
  const p = await newProfile({ monthlyScoringUsd: 0.05 });
  const user = `g3${Date.now()}`;
  addTweets(user, 10);
  await watch(p.id, [user]);
  assert.equal(scoringAllowance(await getUsageBudget(p)), 5, "$0.05 at the $0.01 default");

  let r = await runScout(p.id);
  if (r.status !== "completed") throw new Error(r.status);
  assert.equal(r.stats.scoring?.scored, 5);
  assert.equal(r.stats.scoring?.unscored, 5);
  assert.notEqual((await watchedCursor(p.id, user))?.sinceId, "1", "posts stored, cursor moved");

  await setOverrides(p.id, { monthlyScoringUsd: 10 });
  await ageRuns(p.id);
  r = await runScout(p.id);
  if (r.status !== "completed") throw new Error(r.status);
  assert.equal(r.stats.candidates, 0, "no post fetched twice");
  assert.equal(r.stats.scoring?.scored, 5, "the waiting five are scored");
  assert.equal(r.stats.scoring?.unscored, 0);

  // Reply budget, on an opportunity from these runs
  const [opportunity] = await db
    .select()
    .from(s.opportunitiesTable)
    .where(eq(s.opportunitiesTable.profileId, p.id))
    .limit(1);
  await setOverrides(p.id, { monthlyReplyUsd: 0 });
  const aiCalls = ai.calls.length;
  const blocked = await generateReplies(p.id, opportunity.id, { styles: ["natural", "funny"] });
  assert.equal(blocked.status, "budget_exhausted");
  assert.equal(ai.calls.length, aiCalls, "no AI call");
  await setOverrides(p.id, { monthlyReplyUsd: 5 });
  assert.equal(
    (await generateReplies(p.id, opportunity.id, { styles: ["natural", "funny"] })).status,
    "generated",
  );
  const [usage] = await db
    .select()
    .from(s.aiUsageTable)
    .where(and(eq(s.aiUsageTable.profileId, p.id), eq(s.aiUsageTable.operation, "reply_generation")));
  assert.equal(usage.scoutRunId, opportunity.scoutRunId, "reply cost tied to its run");

  const analytics = await getRunAnalytics(await getProfile(p.id));
  const run = analytics.runs.find((item) => item.id === opportunity.scoutRunId)!;
  assert.ok(Math.abs(run.xUsd - (run.postResources ?? 0) * 0.005) < 1e-9);
  assert.ok(run.replyUsd > 0 && run.scoringUsd > 0 && run.costPerOpportunity !== null);
});

test("simultaneous runs: one runs, one X request", async () => {
  const p = await newProfile();
  const user = `g4${Date.now()}`;
  addTweets(user, 4);
  await watch(p.id, [user]);
  const calls = x.calls.length;

  const results = await Promise.all([runScout(p.id), runScout(p.id), runScout(p.id)]);
  const statuses = results.map((item) => item.status);
  assert.equal(statuses.filter((status) => status === "completed").length, 1, statuses.join());
  assert.equal(x.calls.length - calls, 1);
  assert.equal((await candidateIds(p.id)).length, 4);
});
