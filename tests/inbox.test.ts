// Day 38 Approval Inbox: assembly (ordering, dedupe, caps, staleness),
// isolation, approve / edit / autosave / AI previews / regenerate / decline,
// learning, budgets and caps, preparation (opt-in, idempotent, concurrent),
// and the boundaries: no X calls, nothing published. OpenAI and X are mocked.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getDraft } from "@/db/queries/content";
import { autoSpend, claimProfilePreparation, freshOpportunities, getDecision, getOriginal, reserveAutoSpend } from "@/db/queries/inbox";
import { getCurrentReplies } from "@/db/queries/replies";
import { recordReplyIntent } from "@/db/queries/replyIntents";
import * as s from "@/db/schema";
import { costCeilingUsd } from "@/lib/ai/ceiling";
import type { UsageLimits } from "@/lib/billing/plans";
import { assembleInbox, greeting, type InboxSources, summarizeInbox } from "@/lib/inbox/assemble";
import { learnPreferences } from "@/lib/inbox/learning";
import { INBOX_CAPS } from "@/lib/inbox/types";
import { isXPostId } from "@/lib/replies/xIntent";
import {
  actOnItem,
  decideRevision,
  droppedReferences,
  loadInbox,
  loadPreferences,
  parseKey,
  prepareInbox,
  preparePost,
  recordDeclineReason,
  reviseText,
  runInboxPreparation,
  saveText,
  windowStart,
} from "@/services/inbox/inbox";
import { runSchedulerTick } from "@/services/scheduler/tick";

import { cleanup, getProfile, newProfile, rememberXUsage } from "./helpers/db";
import { ai, installMocks, nextId, x, xOAuth } from "./helpers/mocks";

const HOUR = 3_600_000;

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);
beforeEach(() => {
  ai.calls.length = 0;
  ai.revision = null;
  ai.failFormats.length = 0;
  x.calls.length = 0;
  delete process.env.INBOX_AUTO_PREPARE_ENABLED;
});

// ---- Fixtures -------------------------------------------------------------------------

async function opportunity(profileId: string, { score = 85, topic = "SaaS onboarding", ageHours = 1, content = "How do you onboard your first SaaS customers?" } = {}) {
  const at = new Date(Date.now() - ageHours * HOUR);
  const [run] = await db.insert(s.scoutRunsTable).values({ profileId, status: "completed" }).returning();
  const [row] = await db
    .insert(s.opportunitiesTable)
    .values({ scoutRunId: run.id, profileId, platform: "x", platformPostId: nextId(), postUrl: "https://x.com/a/status/1", authorHandle: "founder", content, score, topic, reason: "You've built onboarding flows.", createdAt: at, postedAt: at })
    .returning();
  return row;
}

async function replyFor(opportunityId: string, text = "Start with the one job they hired you for.") {
  const [row] = await db.insert(s.repliesTable).values({ opportunityId, variant: "natural", originalContent: text, content: text }).returning();
  return row;
}

async function scoutDraft(profileId: string, text = "Most founders look for customers in the wrong place. Start where they already talk.", overrides: Partial<typeof s.contentDraftsTable.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.contentDraftsTable)
    .values({ profileId, title: "Prepared", goal: "build_authority", format: "post", tone: "conversational", length: "medium", posts: [text], topic: "first customers", origin: "scout", ...overrides })
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
      reason: "They ask for a tool like yours.",
      suggestedAction: "Help first.",
      ...overrides,
    })
    .returning();
  return row;
}

const day = (h: number) => new Date(Date.now() - h * HOUR);

function sources(partial: Partial<InboxSources>): InboxSources {
  return { conversations: [], leads: [], posts: [], reminders: [], recommendations: [], ...partial };
}

const conv = (id: string, score: number, ageHours = 1, reply: string | null = null, topic: string | null = "saas") => ({
  id,
  authorHandle: "a",
  content: `post ${id}`,
  postUrl: null,
  platformPostId: `p-${id}`,
  score,
  topic,
  reason: "Fits.",
  postedAt: day(ageHours),
  createdAt: day(ageHours),
  reply: reply ? { id: `r-${id}`, content: reply } : null,
});

// ---- Assembly (pure) -----------------------------------------------------------------

test("ordering: urgent conversations, then leads, replies, posts, reminders, recommendations", () => {
  const items = assembleInbox(
    sources({
      conversations: [conv("c1", 70, 30), conv("c2", 90, 2), conv("c3", 75, 20, "a reply")],
      leads: [{ id: "l1", authorHandle: "b", content: "need a tool", postUrl: "u", platformPostId: "lp", opportunityId: null, score: 88, reason: "r", createdAt: day(1) }],
      posts: [{ id: "d1", text: "draft", why: "Based on your plan.", topic: null, createdAt: day(1) }],
      reminders: [{ key: "task:t", entityId: "t", title: "Do it", body: null, href: "/strategy", at: day(1) }],
      recommendations: [{ key: "experiment:e", title: "x", text: "Try questions", why: "w", at: day(1) }],
    }),
    new Set(),
    { avoidTopics: [] },
    new Date(),
  );
  assert.deepEqual(
    items.map((i) => `${i.type}:${i.key}`),
    ["conversation:opportunity:c2", "lead:lead:l1", "reply:opportunity:c3", "conversation:opportunity:c1", "post:draft:d1", "reminder:task:t", "recommendation:experiment:e"],
  );
  assert.equal(items[0].label, "Join now");
});

test("dedupe: a lead and its conversation are one card; a reminder about a shown entity is dropped", () => {
  const items = assembleInbox(
    sources({
      conversations: [conv("c1", 85)],
      leads: [{ id: "l1", authorHandle: "a", content: "need it", postUrl: "u", platformPostId: "p-c1", opportunityId: "c1", score: 90, reason: "r", createdAt: day(1) }],
      reminders: [
        { key: "item:1", entityId: "l1", title: "Review lead", body: null, href: "/crm/l1", at: day(1) },
        { key: "followup:l2:1", entityId: "l2", title: "Follow up", body: null, href: "/crm/l2", at: day(1) },
        { key: "item:2", entityId: "l2", title: "Follow up (automation)", body: null, href: "/crm/l2", at: day(1) },
      ],
    }),
    new Set(),
    { avoidTopics: [] },
    new Date(),
  );
  assert.deepEqual(items.map((i) => i.key), ["lead:l1", "followup:l2:1"]);
});

test("caps: at most 3 conversations (2 with replies), 1 post, 3 reminders; decided items hidden", () => {
  const items = assembleInbox(
    sources({
      conversations: [conv("a", 90, 20, "r"), conv("b", 89, 20, "r"), conv("c", 88, 20, "r"), conv("d", 87, 20), conv("e", 86, 20)],
      posts: [1, 2, 3].map((n) => ({ id: `d${n}`, text: "t", why: "w", topic: null, createdAt: day(n) })),
      reminders: [1, 2, 3, 4, 5].map((n) => ({ key: `item:${n}`, entityId: `e${n}`, title: "t", body: null, href: "/", at: day(n) })),
    }),
    new Set(["opportunity:a"]),
    { avoidTopics: [] },
    new Date(),
  );
  const of = (type: string) => items.filter((i) => i.type === type).length;
  assert.equal(of("reply") + of("conversation"), INBOX_CAPS.conversations);
  assert.equal(of("reply"), 2);
  assert.equal(of("post"), 1);
  assert.equal(of("reminder"), 3);
  assert.ok(!items.some((i) => i.key === "opportunity:a"));
});

test("learned 'not relevant' topics sink below other conversations", () => {
  const items = assembleInbox(sources({ conversations: [conv("crypto", 90, 20, null, "Crypto"), conv("saas", 80, 20)] }), new Set(), { avoidTopics: ["crypto"] }, new Date());
  assert.deepEqual(items.map((i) => i.key), ["opportunity:saas", "opportunity:crypto"]);
});

test("summary and greeting are deterministic: no AI", () => {
  const items = assembleInbox(sources({ conversations: [conv("a", 70, 20), conv("b", 70, 20)], posts: [{ id: "d", text: "t", why: "w", topic: null, createdAt: day(1) }] }), new Set(), { avoidTopics: [] }, new Date());
  assert.deepEqual(summarizeInbox(items), { total: 3, parts: ["2 conversations worth joining", "1 post ready for review"] });
  assert.equal(greeting("08:15"), "Good morning");
  assert.equal(greeting("14:00"), "Good afternoon");
  assert.equal(greeting("21:00"), "Good evening");
  assert.equal(ai.calls.length, 0);
});

test("keys: only known shapes are accepted", () => {
  assert.equal(parseKey("draft:00000000-0000-0000-0000-000000000000")?.kind, "draft");
  assert.equal(parseKey("followup:00000000-0000-0000-0000-000000000000:1700000000000")?.extra, "1700000000000");
  assert.equal(parseKey("draft:../../etc"), null);
  assert.equal(parseKey("profile:00000000-0000-0000-0000-000000000000"), null);
});

// ---- Learning (pure) ------------------------------------------------------------------

test("learning: one action changes nothing; repeated consistent signals do", () => {
  const decline = (reason: string, topic: string | null = null) => ({ kind: "decision" as const, itemType: "post", decision: "declined", reason, topic, goal: null, originalLength: null, finalLength: null });
  const shortened = { kind: "decision" as const, itemType: "post", decision: "approved", reason: null, topic: null, goal: "educate", originalLength: 200, finalLength: 120 };
  assert.deepEqual(learnPreferences([decline("too_promotional"), shortened]).evidence, []);

  const prefs = learnPreferences([
    decline("too_promotional"),
    decline("too_promotional"),
    shortened,
    shortened,
    shortened,
    decline("not_relevant", "Crypto"),
    decline("not_relevant", "crypto"),
  ]);
  assert.equal(prefs.lessPromotional, true);
  assert.equal(prefs.shorter, true);
  assert.deepEqual(prefs.avoidTopics, ["crypto"]);
  assert.equal(prefs.favoredGoal, "educate");
  assert.equal(prefs.evidence.length, 4);
  // Promotion is never learned upward
  const promo = { ...shortened, goal: "promote_product" };
  assert.equal(learnPreferences([promo, promo, promo]).favoredGoal, null);
});

// ---- Service (test database) ---------------------------------------------------------

test("inbox: built from stored data only, isolated per user, stale items left out", async () => {
  const me = await newProfile();
  const other = await newProfile();
  const fresh = await opportunity(me.id, { score: 88 });
  await opportunity(me.id, { score: 95, ageHours: 60 });
  await opportunity(other.id, { score: 99 });
  const draft = await scoutDraft(me.id);
  await scoutDraft(me.id, "Old one", { createdAt: day(8 * 24) });
  await scoutDraft(other.id, "Someone else's draft");

  const { items, summary } = await loadInbox(me);
  assert.deepEqual(items.map((i) => i.key).sort(), [`draft:${draft.id}`, `opportunity:${fresh.id}`].sort());
  assert.equal(summary.total, 2);
  assert.equal(x.calls.length, 0, "no X calls");
  assert.equal(ai.calls.length, 0, "no AI calls");

  // Acting on someone else's item does nothing
  const foreign = await scoutDraft(other.id, "Not yours");
  const refused = await actOnItem(me, `draft:${foreign.id}`, "approve");
  assert.equal(refused.ok, false);
  assert.equal((await getDraft(other.id, foreign.id))!.status, "draft");
});

test("approve post: once, saved to Content as ready, never published", async () => {
  const me = await newProfile();
  const draft = await scoutDraft(me.id);
  const key = `draft:${draft.id}`;
  const [first, second] = await Promise.all([actOnItem(me, key, "approve"), actOnItem(me, key, "approve")]);
  assert.ok(first.ok && second.ok);
  assert.equal([first, second].filter((r) => r.ok && r.already).length, 1, "the second click runs nothing");
  const winner = [first, second].find((r) => r.ok && !r.already)!;
  assert.ok(winner.ok);
  assert.match(winner.outcome, /Approved/);
  assert.doesNotMatch(winner.outcome, /Published|Posted/i);
  assert.match(winner.openUrl!, /^https:\/\/x\.com\/intent\/post\?text=/);
  const stored = (await getDraft(me.id, draft.id))!;
  assert.equal(stored.status, "ready");
  assert.equal(stored.publishedConfirmedAt, null);
  assert.equal((await loadInbox(me)).items.length, 0);
  assert.deepEqual(xOAuth.writeCalls, []);
});

test("approve reply: the reply is approved, the conversation kept, X's composer prefilled", async () => {
  const me = await newProfile();
  const opp = await opportunity(me.id);
  const reply = await replyFor(opp.id);
  const items = (await loadInbox(me)).items;
  assert.equal(items[0].type, "reply");
  const result = await actOnItem(me, `opportunity:${opp.id}`, "approve");
  assert.ok(result.ok);
  assert.equal(result.copyText, reply.content);
  assert.match(result.openUrl!, /in_reply_to=/);
  const [row] = await db.select().from(s.repliesTable).where(eq(s.repliesTable.id, reply.id));
  assert.equal(row.status, "approved");
  const [handled] = await db.select().from(s.opportunitiesTable).where(eq(s.opportunitiesTable.id, opp.id));
  assert.equal(handled.status, "saved", "handled in Opportunities: no longer new, not marked replied");
  assert.equal((await freshOpportunities(me.id, new Date(), 48)).length, 0, "it can't come back as unhandled");
  assert.equal((await loadInbox(me)).items.length, 0);
  // Copy / "Reply on X" goes through the existing Day 21 record: opened, never posted
  assert.ok((await recordReplyIntent(me.id, { opportunityId: opp.id, replyId: reply.id, text: reply.content, source: "x_web_intent", isValidPostId: isXPostId })).ok);
  const [opened] = await db.select().from(s.opportunitiesTable).where(eq(s.opportunitiesTable.id, opp.id));
  assert.equal(opened.status, "reply_opened");
});

test("approve reply never downgrades a reply already opened or confirmed on X", async () => {
  const me = await newProfile();
  const opp = await opportunity(me.id);
  await replyFor(opp.id);
  await db.update(s.opportunitiesTable).set({ status: "replied" }).where(eq(s.opportunitiesTable.id, opp.id));
  // A confirmed reply isn't "new", so it's not in the Inbox; approving directly still keeps "replied"
  assert.ok((await actOnItem(me, `opportunity:${opp.id}`, "approve")).ok);
  const [row] = await db.select().from(s.opportunitiesTable).where(eq(s.opportunitiesTable.id, opp.id));
  assert.equal(row.status, "replied");
});

test("decline: one click, gone, draft kept (archived); the reason is optional and needs no AI", async () => {
  const me = await newProfile();
  const draft = await scoutDraft(me.id);
  const key = `draft:${draft.id}`;
  assert.equal((await recordDeclineReason(me, key, "too_promotional")).ok, false, "only after a decline");
  assert.ok((await actOnItem(me, key, "decline")).ok);
  assert.equal((await loadInbox(me)).items.length, 0);
  assert.ok((await getDraft(me.id, draft.id))!.archivedAt);
  assert.ok((await recordDeclineReason(me, key, "too_promotional")).ok);
  assert.equal((await getDecision(me.id, key))!.reason, "too_promotional");
  assert.equal(ai.calls.length, 0);
});

test("autosave keeps the original; another user can't save", async () => {
  const me = await newProfile();
  const other = await newProfile();
  const original = "Start where your customers already talk.";
  const draft = await scoutDraft(me.id, original);
  const key = `draft:${draft.id}`;
  assert.ok((await saveText(me, key, "Start where they already talk.")).ok);
  assert.ok((await saveText(me, key, "Go where they already talk.")).ok);
  assert.deepEqual((await getDraft(me.id, draft.id))!.posts, ["Go where they already talk."]);
  assert.equal(await getOriginal(me.id, key), original);
  assert.equal((await saveText(other, key, "hijack")).ok, false);
  assert.equal((await saveText(me, key, "   ")).ok, false);
});

test("AI edit: a preview first; nothing changes until 'Use this'; each preview decided once", async () => {
  const me = await newProfile();
  const text = "Most founders look for customers in the wrong place. Start where they already talk.";
  const draft = await scoutDraft(me.id, text);
  const key = `draft:${draft.id}`;

  const shorter = await reviseText(me, key, { type: "quick", edit: "shorter" }, text);
  assert.ok(shorter.ok, !shorter.ok ? shorter.message : "");
  assert.ok(shorter.text.length < text.length);
  assert.deepEqual((await getDraft(me.id, draft.id))!.posts, [text], "not applied yet");
  const instructions = String(ai.requests.at(-1)!.instructions);
  assert.match(instructions, /Preserve its facts/);

  assert.ok((await decideRevision(me, shorter.revisionId, false)).ok);
  assert.deepEqual((await getDraft(me.id, draft.id))!.posts, [text], "Keep original");

  await new Promise((r) => setTimeout(r, 3100));
  const custom = await reviseText(me, key, { type: "custom", instruction: "Make it more casual." }, text);
  assert.ok(custom.ok);
  assert.match(String(ai.requests.at(-1)!.instructions), /Make it more casual/);
  assert.ok((await decideRevision(me, custom.revisionId, true)).ok);
  assert.deepEqual((await getDraft(me.id, draft.id))!.posts, [custom.text]);
  const again = await decideRevision(me, custom.revisionId, false);
  assert.ok(again.ok && again.already, "decided once");
  assert.equal(await getOriginal(me.id, key), text, "the original is kept");
});

test("regenerate reply: a new AI version replaces it only on 'Use this'; the old one is kept", async () => {
  const me = await newProfile();
  const opp = await opportunity(me.id);
  const before = await replyFor(opp.id, "Ask what they tried first.");
  const key = `opportunity:${opp.id}`;
  const result = await reviseText(me, key, { type: "regenerate" }, before.content);
  assert.ok(result.ok);
  assert.match(String(ai.requests.at(-1)!.instructions), /reply on X/);
  assert.ok((await decideRevision(me, result.revisionId, true)).ok);
  const current = (await getCurrentReplies(me.id, [opp.id])).get(opp.id)!;
  assert.equal(current[0].content, result.text);
  assert.equal(current[0].originalContent, result.text, "Scout's version, not counted as the user's edit");
  const [old] = await db.select().from(s.repliesTable).where(eq(s.repliesTable.id, before.id));
  assert.equal(old.status, "discarded");
});

test("budget and caps: no AI call without writing budget, per-item and pacing limits hold", async () => {
  const broke = await newProfile({ monthlyReplyUsd: 0 });
  const draft = await scoutDraft(broke.id);
  const refused = await reviseText(broke, `draft:${draft.id}`, { type: "regenerate" }, draft.posts[0]);
  assert.equal(refused.ok, false);
  assert.equal(ai.calls.length, 0);
  assert.equal((await preparePost(broke)).ok, true, "a waiting post is returned, nothing written");

  const me = await newProfile({ maxInboxRevisionsPerDay: 1 });
  const mine = await scoutDraft(me.id);
  assert.ok((await reviseText(me, `draft:${mine.id}`, { type: "regenerate" }, mine.posts[0])).ok);
  const capped = await reviseText(me, `draft:${mine.id}`, { type: "regenerate" }, mine.posts[0]);
  assert.equal(capped.ok, false);
  assert.equal(ai.calls.filter((c) => c === "inbox_revision").length, 1);

  assert.equal((await reviseText(me, `draft:${mine.id}`, { type: "quick", edit: "make-it-viral" }, "x")).ok, false);
});

test("dropped links and mentions are flagged on the preview", () => {
  assert.deepEqual(droppedReferences("Thanks @marc, see https://scout.ai/x", "Thanks, see it"), ["@marc", "https://scout.ai/x"]);
  assert.deepEqual(droppedReferences("Hi @a", "Hello @A"), []);
});

test("reminders: done closes the CRM follow-up; snooze hides until tomorrow", async () => {
  const me = await newProfile();
  const due = await lead(me.id, { saved: true, status: "contacted", followUpAt: day(2), followUpNote: "Ask how the trial went" });
  const other = await lead(me.id, { saved: true, status: "contacted", followUpAt: day(1) });
  const keys = (await loadInbox(me)).items.filter((i) => i.type === "reminder").map((i) => i.key);
  assert.equal(keys.length, 2);
  const dueKey = keys.find((k) => k.includes(due.id))!;
  assert.ok((await actOnItem(me, dueKey, "done")).ok);
  const [closed] = await db.select().from(s.leadsTable).where(eq(s.leadsTable.id, due.id));
  assert.ok(closed.followUpDoneAt);

  const otherKey = keys.find((k) => k.includes(other.id))!;
  assert.ok((await actOnItem(me, otherKey, "snooze")).ok);
  assert.ok(!(await loadInbox(me)).items.some((i) => i.key === otherKey));
  assert.ok((await loadInbox(me, new Date(Date.now() + 25 * HOUR))).items.some((i) => i.key === otherKey), "back after the snooze");
  assert.equal((await actOnItem(me, otherKey, "approve")).ok, false, "reminders can't be approved");
});

test("leads and conversations: Save uses the existing CRM and opportunity systems", async () => {
  const me = await newProfile();
  const l = await lead(me.id);
  const opp = await opportunity(me.id, { score: 70 });
  assert.ok((await actOnItem(me, `lead:${l.id}`, "save")).ok);
  assert.ok((await actOnItem(me, `opportunity:${opp.id}`, "save")).ok);
  const [savedLead] = await db.select().from(s.leadsTable).where(eq(s.leadsTable.id, l.id));
  const [savedOpp] = await db.select().from(s.opportunitiesTable).where(eq(s.opportunitiesTable.id, opp.id));
  assert.equal(savedLead.saved, true);
  assert.equal(savedOpp.status, "saved");
  assert.equal((await loadInbox(me)).items.length, 0);
});

test("learning from Inbox decisions is used in generation and can be reset", async () => {
  const me = await newProfile();
  for (let i = 0; i < 2; i++) {
    const d = await scoutDraft(me.id, `Promo ${i}`);
    await actOnItem(me, `draft:${d.id}`, "decline");
    await recordDeclineReason(me, `draft:${d.id}`, "too_promotional");
  }
  const prefs = await loadPreferences(await getProfile(me.id));
  assert.equal(prefs.lessPromotional, true);

  const result = await preparePost(await getProfile(me.id));
  assert.ok(result.ok, !result.ok ? result.message : "");
  assert.match(String(ai.requests.at(-1)!.instructions), /dislikes promotional drafts/);

  await db.update(s.profilesTable).set({ inboxLearningResetAt: new Date(Date.now() + 1000) }).where(eq(s.profilesTable.id, me.id));
  assert.equal((await loadPreferences(await getProfile(me.id))).lessPromotional, false);
});

test("preparePost: one waiting post at a time, marked as Scout's, original kept", async () => {
  const me = await newProfile();
  const first = await preparePost(me);
  assert.ok(first.ok && !first.already);
  const draft = (await getDraft(me.id, first.draftId))!;
  assert.equal(draft.origin, "scout");
  assert.equal(draft.format, "post");
  assert.ok(await getOriginal(me.id, `draft:${draft.id}`));
  const calls = ai.calls.length;
  const second = await preparePost(me);
  assert.ok(second.ok && second.already && second.draftId === first.draftId);
  assert.equal(ai.calls.length, calls, "no duplicate draft");
});

// ---- Automatic preparation (hardening) -----------------------------------------------

async function trend(profileId: string, { saved = true, relevance = 80, label = "AI onboarding" } = {}) {
  const [row] = await db
    .insert(s.trendsTable)
    .values({
      profileId,
      key: `t-${nextId()}`,
      label,
      status: "rising",
      confidence: "medium",
      score: 70,
      relevance,
      scoreBreakdown: {} as never,
      momentum: {} as never,
      dailyCounts: [],
      postCount: 6,
      authorCount: 4,
      engagement: 120,
      representativeCandidateIds: [],
      firstPostAt: day(48),
      lastPostAt: day(2),
      saved,
    })
    .returning();
  return row;
}

/** An opted-in profile on a real plan's automatic limits (TEST_LIMITS don't set them) */
async function optedIn(plan: "free" | "starter" | "pro" | "internal", overrides: Partial<UsageLimits> = {}) {
  const p = await newProfile(overrides);
  await db.update(s.profilesTable).set({ plan, autoPrepareEnabled: true, onboardingCompleted: true }).where(eq(s.profilesTable.id, p.id));
  return getProfile(p.id);
}

const committed = async (profileId: string, now = new Date()) => autoSpend(profileId, windowStart("month", now));
const generations = () => ai.calls.filter((c) => c === "content_draft" || c === "reply_drafts").length;

test("automatic preparation: off globally and per user by default", async () => {
  const me = await optedIn("pro");
  await opportunity(me.id, { score: 90 });
  await trend(me.id);
  assert.deepEqual(await runInboxPreparation(), { disabled: true, profiles: 0, posts: 0, replies: 0 });
  assert.equal((await prepareInbox(me)).skipped[0], "off");
  process.env.INBOX_AUTO_PREPARE_ENABLED = "true";
  await db.update(s.profilesTable).set({ autoPrepareEnabled: false }).where(eq(s.profilesTable.id, me.id));
  assert.equal((await prepareInbox(await getProfile(me.id))).skipped[0], "off", "not opted in");
  assert.equal(ai.calls.length, 0);
});

test("Free: at most 2 posts a month and $0.05 of automatic spending, whatever the number of runs", async () => {
  process.env.INBOX_AUTO_PREPARE_ENABLED = "true";
  const me = await optedIn("free");
  await trend(me.id, { label: "first customers" });
  await trend(me.id, { label: "pricing pages" });
  await trend(me.id, { label: "cold outreach" });
  const month = new Date();
  let posts = 0;
  for (let run = 0; run < 5; run++) {
    const result = await prepareInbox(await getProfile(me.id), month);
    posts += result.posts;
    // The user declines each prepared post, so a new one could be prepared
    for (const item of (await loadInbox(await getProfile(me.id), month)).items.filter((i) => i.type === "post")) await actOnItem(me, item.key, "decline");
  }
  assert.ok(posts >= 1 && posts <= 2, `posts: ${posts}`);
  assert.ok((await committed(me.id, month)) <= 0.05 + 1e-9);
  assert.equal(generations(), posts, "a refused or capped step makes no AI call");
  assert.equal(x.calls.length, 0);
});

test("budget reservations are atomic: concurrent reservations never pass the cap", async () => {
  const me = await newProfile();
  const month = windowStart("month", new Date());
  const results = await Promise.all(Array.from({ length: 12 }, () => reserveAutoSpend(me.id, month, 0.01, 0.05)));
  assert.equal(results.filter(Boolean).length, 5);
  assert.ok(Math.abs((await autoSpend(me.id, month)) - 0.05) < 1e-9);
  assert.equal(await reserveAutoSpend(me.id, month, 0.06, 0.05), false, "a single call over the cap is refused too");
});

test("manual protection: automatic preparation never uses the writing budget kept for the user", async () => {
  process.env.INBOX_AUTO_PREPARE_ENABLED = "true";
  // Starter keeps $0.20 for the user: with $0.21 left, no automatic call fits
  const me = await optedIn("starter", { monthlyReplyUsd: 0.21 });
  await trend(me.id);
  const result = await prepareInbox(me);
  assert.equal(result.posts, 0);
  assert.ok(result.skipped.includes("post refused"), result.skipped.join(", "));
  assert.equal(generations(), 0);
  assert.equal(await committed(me.id), 0);
  assert.equal((await db.select().from(s.inboxPreparationsTable).where(eq(s.inboxPreparationsTable.profileId, me.id))).length, 0, "the slot is given back");
  // What the user asks for still works
  assert.ok((await preparePost(me)).ok);
  assert.equal(generations(), 1);
});

test("failures and retries: a failed call settles to what it cost and frees its slot; no SDK retries", async () => {
  process.env.INBOX_AUTO_PREPARE_ENABLED = "true";
  const me = await optedIn("pro");
  await trend(me.id);
  ai.failFormats.push("content_draft");
  const failed = await prepareInbox(me);
  assert.equal(failed.posts, 0);
  assert.ok(failed.skipped.includes("post failed"));
  assert.equal(ai.calls.filter((c) => c === "content_draft").length, 1, "made once, not retried by the SDK");
  assert.equal(await committed(me.id), 0, "the reservation is released: nothing was spent");
  const again = await prepareInbox(await getProfile(me.id));
  assert.equal(again.posts, 1, "the next run may try again");
  assert.ok((await committed(me.id)) > 0);
});

test("Pro: daily caps hold with concurrent workers; only strong conversations get replies; no filler", async () => {
  process.env.INBOX_AUTO_PREPARE_ENABLED = "true";
  const me = await optedIn("pro");
  await opportunity(me.id, { score: 92 });
  await opportunity(me.id, { score: 88 });
  await opportunity(me.id, { score: 86 });
  const weak = await opportunity(me.id, { score: 60 });
  const [a, b] = await Promise.all([prepareInbox(me), prepareInbox(me)]);
  assert.equal(a.replies + b.replies, 2, "2 reply sets a day");
  assert.equal(a.posts + b.posts, 0, "no trend or plan task: no post, no filler");
  assert.ok([...a.skipped, ...b.skipped].some((n) => n.startsWith("post")));
  assert.equal((await getCurrentReplies(me.id, [weak.id])).size, 0, "a weak conversation gets nothing");
  const preps = await db.select().from(s.inboxPreparationsTable).where(eq(s.inboxPreparationsTable.profileId, me.id));
  assert.equal(preps.length, 2);
  assert.ok(preps.every((p) => p.status === "done" && (p.costUsd ?? 0) > 0));
  assert.ok((await committed(me.id)) <= 1.8);
});

test("scheduler: the 5-minute cron prepares once, then doesn't spend again on the next ticks", async () => {
  process.env.INBOX_AUTO_PREPARE_ENABLED = "true";
  const me = await optedIn("pro");
  await opportunity(me.id, { score: 90 });
  await trend(me.id);
  const first = await runSchedulerTick({ maxJobs: 0, cleanup: false });
  assert.ok(first.inbox && first.inbox.profiles >= 1, "runs without the user opening Scout");
  const afterFirst = generations();
  assert.ok(afterFirst >= 2, "a reply set and a post");
  const second = await runSchedulerTick({ maxJobs: 0, cleanup: false });
  const third = await runSchedulerTick({ maxJobs: 0, cleanup: false });
  assert.equal(generations(), afterFirst, "no AI on the next ticks");
  assert.equal((second.inbox?.profiles ?? 0) + (third.inbox?.profiles ?? 0), 0);
  // Two workers claiming the same profile: one wins
  await db.update(s.profilesTable).set({ inboxPreparedAt: null }).where(eq(s.profilesTable.id, me.id));
  const claims = await Promise.all([claimProfilePreparation(me.id, new Date(), 6), claimProfilePreparation(me.id, new Date(), 6)]);
  assert.deepEqual(claims.sort(), [false, true]);
  // Another 6 hours later, the day's caps still hold: nothing new
  const later = await prepareInbox(await getProfile(me.id), new Date(Date.now() + 60_000));
  assert.equal(later.posts + later.replies, 0);
  await db.update(s.profilesTable).set({ autoPrepareEnabled: false }).where(eq(s.profilesTable.id, me.id));
});

test("windows: day, week from Monday, calendar month (UTC)", () => {
  const thursday = new Date("2026-11-19T10:00:00Z");
  assert.equal(windowStart("day", thursday), "2026-11-19");
  assert.equal(windowStart("week", thursday), "2026-11-16");
  assert.equal(windowStart("week", new Date("2026-11-16T00:30:00Z")), "2026-11-16");
  assert.equal(windowStart("week", new Date("2026-11-22T23:00:00Z")), "2026-11-16", "Sunday belongs to the week before");
  assert.equal(windowStart("month", thursday), "2026-11-01");
});

test("ceiling: from the prompt's bytes and the output cap; unpriced models can't be bounded", () => {
  const ceiling = costCeilingUsd("gpt-5.5-2026-04-23", ["a".repeat(1000), "é"], 600)!;
  assert.ok(Math.abs(ceiling - (1002 * 5 + 600 * 30) / 1_000_000) < 1e-12);
  assert.equal(costCeilingUsd("some-new-model", ["x"], 600), null);
});
