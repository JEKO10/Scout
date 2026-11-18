// Day 36 Automation Scout: rules, builder validation, templates, the engine
// (idempotency, duplicates, concurrency, retries, failures, limits, kill
// switch), notifications and the review queue, strategy reminders, AI
// opt-in and budget, isolation. OpenAI and X are mocked; no automation may
// call X.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { and, eq } from "drizzle-orm";

import db from "@/db";
import { getAutomation, listQueue, setItemStatus } from "@/db/queries/automations";
import * as s from "@/db/schema";
import { dayLabel, dueLabel } from "@/lib/automations/format";
import { type AutomationEvent, matchConditions, validateAutomation } from "@/lib/automations/rules";
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import { ACTIONS_FOR, AUTOMATION_ACTIONS } from "@/lib/automations/types";
import { runAutomations } from "@/services/automations/engine";
import { createAutomation, editAutomation, enableGrowthPlanReminders, loadAutomationsView, removeAutomation, toggleAutomation } from "@/services/automations/manage";

import { cleanup, getProfile, newProfile, rememberXUsage, setOverrides } from "./helpers/db";
import { ai, installMocks, nextId, x } from "./helpers/mocks";

const HOUR = 3_600_000;

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);
beforeEach(() => {
  ai.calls.length = 0;
  x.calls.length = 0;
  delete process.env.AUTOMATIONS_KILL_SWITCH;
});

/** Runs the engine only for these profiles' automations (other test files' rows are excluded by profile) */
async function tick(now = new Date()) {
  return runAutomations({ now, maxAutomations: 200, timeBudgetMs: 60_000 });
}

async function opportunity(profileId: string, { score = 85, topic = "SaaS onboarding", createdAt = new Date() } = {}) {
  const [run] = await db.insert(s.scoutRunsTable).values({ profileId, status: "completed" }).returning();
  const [row] = await db
    .insert(s.opportunitiesTable)
    .values({
      scoutRunId: run.id,
      profileId,
      platform: "x",
      platformPostId: nextId(),
      postUrl: "https://x.com/a/status/1",
      authorHandle: "founder",
      content: "How do you onboard your first SaaS customers?",
      score,
      topic,
      createdAt,
      postedAt: createdAt,
    })
    .returning();
  return row;
}

async function lead(profileId: string, overrides: Partial<typeof s.leadsTable.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.leadsTable)
    .values({
      profileId,
      platform: "x",
      platformPostId: nextId(),
      authorHandle: "buyer",
      postUrl: "https://x.com/buyer/status/1",
      content: "Looking for a tool to find customers on X",
      postedAt: new Date(),
      intent: "high",
      score: 90,
      scoreBreakdown: {} as never,
      evidence: "Looking for a tool",
      reason: "They ask for a tool.",
      suggestedAction: "Reply helpfully.",
      ...overrides,
    })
    .returning();
  return row;
}

const opportunityEvent = (facts: AutomationEvent["facts"]): AutomationEvent => ({
  trigger: "new_opportunity", key: "k", entityId: "e", at: new Date(), title: "t", body: null, href: "/", sourceModule: "Opportunities", entityType: "opportunity", facts,
});

// ---- Rules ---------------------------------------------------------------------------

test("conditions: deterministic, unknown facts never pass", () => {
  assert.deepEqual(matchConditions({ minScore: 80 }, opportunityEvent({ score: 85 })), { match: true });
  assert.equal(matchConditions({ minScore: 80 }, opportunityEvent({ score: 70 })).match, false);
  assert.equal(matchConditions({ minScore: 80 }, opportunityEvent({})).match, false, "unknown score");
  assert.equal(matchConditions({ textContains: "onboarding" }, opportunityEvent({ text: "SaaS Onboarding tips" })).match, true);
  assert.equal(matchConditions({ maxAgeHours: 24 }, opportunityEvent({ ageHours: 30 })).match, false);
  assert.equal(matchConditions({ minConfidence: "medium" }, opportunityEvent({ confidence: "high" })).match, true);
  assert.equal(matchConditions({ minConfidence: "medium" }, opportunityEvent({ confidence: "low" })).match, false);
  assert.equal(matchConditions({ intents: ["high"] }, opportunityEvent({ intent: "medium" })).match, false);
});

test("builder validation: actions must fit the trigger; foreign conditions are dropped; nothing posts to X", () => {
  assert.equal(validateAutomation({ name: "x", trigger: "relevant_trend", actions: ["save_lead"] }).ok, false);
  const ok = validateAutomation({ name: "Trends", trigger: "relevant_trend", conditions: { minRelevance: 60, minScore: 90 }, actions: ["notify", "notify"] });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.value.conditions, { minRelevance: 60 }, "minScore isn't a trend condition");
    assert.deepEqual(ok.value.actions, ["notify"]);
  }
  assert.equal(validateAutomation({ name: "x", trigger: "new_opportunity", actions: ["post_reply"] }).ok, false);
  assert.ok(!AUTOMATION_ACTIONS.some((a) => /post|send|follow|dm/.test(a)), "no action can post, send or follow");
  for (const t of AUTOMATION_TEMPLATES) assert.ok(validateAutomation({ ...t, enabled: false }).ok, `template ${t.key} is valid`);
  assert.ok(Object.values(ACTIONS_FOR).every((actions) => actions.includes("notify")));
});

// ---- Management ---------------------------------------------------------------------

test("create, edit, disable, delete; the plan's active limit applies; templates aren't active until saved", async () => {
  const p = await newProfile({ maxActiveAutomations: 1 });
  const profile = await getProfile(p.id);
  assert.equal((await loadAutomationsView(profile)).automations.length, 0, "no template is activated on its own");

  const first = await createAutomation(profile, { name: "Leads", trigger: "high_intent_lead", actions: ["notify"] });
  assert.ok(first.ok);
  const second = await createAutomation(profile, { name: "Trends", trigger: "relevant_trend", actions: ["notify"] });
  assert.equal(second.ok, false, "over the active limit");
  assert.ok((await createAutomation(profile, { name: "Off one", trigger: "relevant_trend", actions: ["notify"], enabled: false })).ok, "saving it turned off is fine");

  const id = (first as { id: string }).id;
  assert.ok((await editAutomation(profile, id, { name: "Hot leads", trigger: "high_intent_lead", conditions: { minScore: 70 }, actions: ["notify", "review"] })).ok);
  const edited = (await getAutomation(p.id, id))!;
  assert.equal(edited.name, "Hot leads");
  assert.deepEqual(edited.conditions, { minScore: 70 });
  assert.ok((await toggleAutomation(profile, id, false)).ok);
  assert.equal((await getAutomation(p.id, id))!.enabled, false);
  assert.ok((await removeAutomation(profile, id)).ok);
  assert.equal(await getAutomation(p.id, id), undefined);
});

// ---- Engine --------------------------------------------------------------------------

test("new opportunity: matching events notify and queue once; non-matching are skipped; history is never replayed", async () => {
  const p = await newProfile();
  const old = await opportunity(p.id, { createdAt: new Date(Date.now() - 2 * HOUR) });
  const profile = await getProfile(p.id);
  const created = (await createAutomation(profile, { name: "Strong", trigger: "new_opportunity", conditions: { minScore: 80 }, actions: ["notify", "review", "save_opportunity"] })) as { id: string };
  const strong = await opportunity(p.id, { score: 92 });
  const weak = await opportunity(p.id, { score: 40 });

  await tick();
  const runs = await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.automationId, created.id));
  assert.deepEqual(runs.map((r) => [r.entityId, r.status]).sort(), [[strong.id, "succeeded"], [weak.id, "skipped"]].sort());
  assert.ok(!runs.some((r) => r.entityId === old.id), "created before the automation: not replayed");
  assert.equal(runs.find((r) => r.entityId === weak.id)!.counted, false, "skips don't count");
  const items = await db.select().from(s.automationItemsTable).where(eq(s.automationItemsTable.profileId, p.id));
  assert.deepEqual(items.map((i) => i.kind).sort(), ["notification", "review"]);
  assert.equal(items[0].href, `/opportunities/${strong.id}`);
  const [saved] = await db.select().from(s.opportunitiesTable).where(eq(s.opportunitiesTable.id, strong.id));
  assert.equal(saved.status, "saved");

  await tick();
  assert.equal((await db.select().from(s.automationItemsTable).where(eq(s.automationItemsTable.profileId, p.id))).length, 2, "no duplicates on the next tick");
  assert.equal(x.calls.length, 0, "no X call");
  assert.equal(ai.calls.length, 0, "no AI without the opt-in");
});

test("concurrency: two workers at once process each event once", async () => {
  const p = await newProfile();
  await createAutomation(await getProfile(p.id), { name: "All", trigger: "new_opportunity", actions: ["notify"] });
  for (let i = 0; i < 3; i++) await opportunity(p.id);
  await Promise.all([tick(), tick(), tick()]);
  const runs = await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.profileId, p.id));
  assert.equal(runs.length, 3);
  assert.equal((await db.select().from(s.automationItemsTable).where(eq(s.automationItemsTable.profileId, p.id))).length, 3);
});

test("monthly limit: runs stop counting at the plan's allowance; skipped ones aren't counted", async () => {
  const p = await newProfile({ maxAutomationRunsPerMonth: 2 });
  await createAutomation(await getProfile(p.id), { name: "All", trigger: "new_opportunity", actions: ["notify"] });
  for (let i = 0; i < 4; i++) await opportunity(p.id);
  await tick();
  const runs = await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.profileId, p.id));
  assert.equal(runs.filter((r) => r.counted).length, 2);
  assert.equal(runs.filter((r) => r.reason === "monthly automation limit reached: not run, not counted").length, 2);
  const view = await loadAutomationsView(await getProfile(p.id));
  assert.deepEqual([view.usage.used, view.usage.limit], [2, 2]);
  assert.match(view.automations[0].automation.lastError ?? "", /Monthly limit/);
});

test("retries: a failing action fails the run, retries with backoff, never duplicates items", async () => {
  const p = await newProfile();
  const created = (await createAutomation(await getProfile(p.id), { name: "Save", trigger: "new_opportunity", actions: ["notify", "save_opportunity"] })) as { id: string };
  const opp = await opportunity(p.id);
  // Make "save_opportunity" fail once: the opportunity status update is blocked by a trigger-free trick, a bad enum write
  const original = db.update.bind(db);
  let failNext = true;
  (db as unknown as { update: typeof db.update }).update = ((table: Parameters<typeof db.update>[0]) => {
    if (table === s.opportunitiesTable && failNext) {
      failNext = false;
      throw new Error("database busy");
    }
    return original(table);
  }) as typeof db.update;
  try {
    await tick();
  } finally {
    (db as unknown as { update: typeof db.update }).update = original;
  }
  let [run] = await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.automationId, created.id));
  assert.equal(run.status, "failed");
  assert.match(run.reason ?? "", /save_opportunity: database busy/);
  assert.ok(run.nextRetryAt && run.nextRetryAt > new Date(), "retry later, not every tick");

  await tick(new Date(Date.now() + 6 * 60_000));
  [run] = await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.automationId, created.id));
  assert.equal(run.status, "succeeded");
  assert.equal(run.attempts, 2);
  assert.equal(run.counted, true);
  const notifications = await db.select().from(s.automationItemsTable).where(and(eq(s.automationItemsTable.profileId, p.id), eq(s.automationItemsTable.kind, "notification")));
  assert.equal(notifications.length, 1, "the retry didn't add a second notification");
  void opp;
});

test("disabled and deleted automations don't run; turning one back on doesn't replay what happened meanwhile", async () => {
  const p = await newProfile();
  const profile = await getProfile(p.id);
  const created = (await createAutomation(profile, { name: "All", trigger: "new_opportunity", actions: ["notify"] })) as { id: string };
  await toggleAutomation(profile, created.id, false);
  await opportunity(p.id);
  await tick();
  assert.equal((await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.automationId, created.id))).length, 0);
  await toggleAutomation(profile, created.id, true);
  await tick();
  assert.equal((await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.automationId, created.id))).length, 0, "the event happened while it was off");
  await removeAutomation(profile, created.id);
  await opportunity(p.id);
  await tick();
  assert.equal((await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.profileId, p.id))).length, 0);
});

test("kill switch: nothing runs while it's on", async () => {
  const p = await newProfile();
  await createAutomation(await getProfile(p.id), { name: "All", trigger: "new_opportunity", actions: ["notify"] });
  await opportunity(p.id);
  process.env.AUTOMATIONS_KILL_SWITCH = "true";
  const result = await tick();
  assert.equal(result.paused, true);
  assert.equal((await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.profileId, p.id))).length, 0);
});

test("leads: saved to CRM and queued; an AI draft only with the opt-in, from the writing budget, never sent", async () => {
  const p = await newProfile();
  const profile = await getProfile(p.id);
  await createAutomation(profile, { name: "Customers", trigger: "high_intent_lead", conditions: { intents: ["high"] }, actions: ["save_lead", "review", "ai_reply_draft"] });
  // A lead found in a scan has the opportunity its reply goes through
  const conversation = await opportunity(p.id, { score: 70, createdAt: new Date(Date.now() - 3 * HOUR) });
  const hot = await lead(p.id, { opportunityId: conversation.id });
  await lead(p.id, { intent: "low", score: 20 });
  await tick();
  const [saved] = await db.select().from(s.leadsTable).where(eq(s.leadsTable.id, hot.id));
  assert.equal(saved.saved, true);
  assert.equal(ai.calls.filter((c) => c === "reply_drafts").length, 1, "one draft call, for the matching lead only");
  const [run] = await db.select().from(s.automationRunsTable).where(and(eq(s.automationRunsTable.profileId, p.id), eq(s.automationRunsTable.status, "succeeded")));
  assert.match(JSON.stringify(run.actionResults), /not sent/);
  assert.ok((run.aiCostUsd ?? 0) > 0, "actual AI cost recorded");
  assert.equal(x.calls.length, 0, "drafting never calls X");

  // No writing budget: the draft is skipped, the rest still happens
  const poor = await newProfile({ monthlyReplyUsd: 0 });
  await createAutomation(await getProfile(poor.id), { name: "Customers", trigger: "high_intent_lead", actions: ["review", "ai_reply_draft"] });
  const poorConversation = await opportunity(poor.id, { createdAt: new Date(Date.now() - 3 * HOUR) });
  await lead(poor.id, { opportunityId: poorConversation.id });
  ai.calls.length = 0;
  await tick();
  const [poorRun] = await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.profileId, poor.id));
  assert.equal(poorRun.status, "succeeded");
  assert.match(JSON.stringify(poorRun.actionResults), /budget used up/);
  assert.equal(ai.calls.length, 0);
  assert.equal((await listQueue(poor.id)).length, 1);
});

test("review queue: closing an item marks its notification read; another user can't touch it", async () => {
  const p = await newProfile();
  const other = await newProfile();
  await createAutomation(await getProfile(p.id), { name: "All", trigger: "new_opportunity", actions: ["notify", "review"] });
  await opportunity(p.id);
  await tick();
  const [item] = await listQueue(p.id);
  assert.equal(await setItemStatus(other.id, item.id, "dismissed"), false);
  assert.ok(await setItemStatus(p.id, item.id, "reviewed"));
  assert.equal((await listQueue(p.id)).length, 0);
  const [notification] = await db.select().from(s.automationItemsTable).where(and(eq(s.automationItemsTable.profileId, p.id), eq(s.automationItemsTable.kind, "notification")));
  assert.ok(notification.readAt, "consistent: the notification is read too");
});

test("strategy reminders: one per due task, from the saved plan, no AI; done tasks are skipped", async () => {
  const p = await newProfile();
  const today = new Date().toISOString().slice(0, 10);
  const [strategy] = await db
    .insert(s.growthStrategiesTable)
    .values({ profileId: p.id, status: "active", mode: "starter", objective: "grow_audience", weeklyMinutes: 60, weekStart: today, evidence: { items: [], missing: [], mode: "starter", snapshot: {} as never, changes: [] }, evidenceKey: "k" })
    .returning();
  const task = (title: string, status: "todo" | "done", day = today) => ({ strategyId: strategy.id, profileId: p.id, day, position: 1, title, objective: "o", activity: "Write one post", reason: "r", effortMinutes: 20, module: "studio", status });
  await db.insert(s.growthPlanTasksTable).values([task("Write a post", "todo"), task("Already done", "done"), task("Tomorrow", "todo", new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))]);

  const first = await enableGrowthPlanReminders(await getProfile(p.id));
  const again = await enableGrowthPlanReminders(await getProfile(p.id));
  assert.ok(first.ok && again.ok);
  assert.equal((first as { id: string }).id, (again as { id: string }).id, "created once");
  await tick();
  await tick();
  const reminders = await listQueue(p.id);
  assert.deepEqual(reminders.map((r) => [r.kind, r.href]), [["reminder", "/studio"]]);
  assert.match(reminders[0].title, /Write a post \(~20 min\)/);
  assert.equal(ai.calls.length, 0);
});

test("content due: a reminder linked to the draft; rescheduling makes a new reminder", async () => {
  const p = await newProfile();
  await createAutomation(await getProfile(p.id), { name: "Schedule", trigger: "content_due", actions: ["reminder"] });
  const [draft] = await db
    .insert(s.contentDraftsTable)
    .values({ profileId: p.id, title: "First customers", goal: "educate", format: "post", tone: "conversational", length: "short", posts: ["x"], plannedAt: new Date(Date.now() - HOUR) })
    .returning();
  await tick();
  assert.deepEqual((await listQueue(p.id)).map((i) => i.href), [`/studio/${draft.id}`]);
  await db.update(s.contentDraftsTable).set({ plannedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(s.contentDraftsTable.id, draft.id));
  await tick();
  assert.equal((await listQueue(p.id)).length, 2, "the rescheduled time is a new event");
});

test("isolation: an automation only ever sees its owner's data", async () => {
  const owner = await newProfile();
  const other = await newProfile();
  const created = (await createAutomation(await getProfile(owner.id), { name: "All", trigger: "new_opportunity", actions: ["notify"] })) as { id: string };
  await opportunity(other.id);
  await tick();
  assert.equal((await db.select().from(s.automationRunsTable).where(eq(s.automationRunsTable.automationId, created.id))).length, 0);
  assert.equal(await getAutomation(other.id, created.id), undefined);
  assert.equal((await editAutomation(await getProfile(other.id), created.id, { name: "Hijack", trigger: "new_opportunity", actions: ["notify"] })).ok, false);
  assert.equal((await removeAutomation(await getProfile(other.id), created.id)).ok, false);
  await setOverrides(owner.id, {});
});

test("due labels: plan tasks read by day in the user's time zone, other reminders by time", () => {
  assert.equal(dayLabel("2026-11-18", "2026-11-18"), "today");
  assert.equal(dayLabel("2026-11-17", "2026-11-18"), "yesterday");
  assert.equal(dayLabel("2026-11-19", "2026-11-18"), "tomorrow");
  assert.equal(dayLabel("2026-11-15", "2026-11-18"), "on Nov 15");
  const relative = () => "in 2 hours";
  const task = { entityType: "strategy_task", dueAt: new Date("2026-11-18T00:00:00Z"), createdAt: new Date() };
  assert.equal(dueLabel(task, "2026-11-18", relative), "due today", "not 'due 21 hours ago'");
  assert.equal(dueLabel({ ...task, entityType: "content" }, "2026-11-18", relative), "due in 2 hours");
  assert.equal(dueLabel({ ...task, dueAt: null }, "2026-11-18", relative), "in 2 hours");
});
