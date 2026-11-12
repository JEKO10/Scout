// Day 21: Reply on X (Web Intent) and reply tracking. No X or OpenAI calls;
// the database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getOpportunities } from "@/db/queries/opportunities";
import {
  confirmReplyPosted,
  getReplyActivity,
  getReplyIntentStats,
  recordReplyIntent,
  returnToFeed,
} from "@/db/queries/replyIntents";
import * as s from "@/db/schema";
import {
  checkReplyText,
  isXPostId,
  normalizeReplyText,
  replyIntentUrl,
  X_REPLY_LIMIT,
  xWeightedLength,
} from "@/lib/replies/xIntent";

import { cleanup, newProfile, rememberXUsage } from "./helpers/db";
import { ai, installMocks, slack, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

test("Web Intent URL: official endpoint, original post ID, safe encoding", () => {
  const text = "Ship it & see 🚀 #buildinpublic\nline two https://scout.app/x?a=1&b=2 — ünïcödé";
  const url = new URL(replyIntentUrl("1900000000000000001", text)!);
  assert.equal(url.origin + url.pathname, "https://x.com/intent/tweet");
  assert.equal(url.searchParams.get("in_reply_to"), "1900000000000000001");
  assert.equal(url.searchParams.get("text"), normalizeReplyText(text), "round-trips exactly, & # and newlines included");
  assert.deepEqual([...url.searchParams.keys()], ["in_reply_to", "text"], "nothing injected through the text");

  // Invalid post IDs or text: no link at all
  for (const id of ["", "abc", "0123", "12-3", "1".repeat(21), "123 456", "../1"]) {
    assert.equal(replyIntentUrl(id, "hi"), null, id);
  }
  assert.equal(replyIntentUrl("123", "   "), null, "empty");
  assert.equal(replyIntentUrl("123", "a".repeat(X_REPLY_LIMIT + 1)), null, "over the limit");
  assert.ok(isXPostId("20") && !isXPostId(undefined));
});

test("X character count: emoji and CJK count 2, links 23, line breaks normalized", () => {
  assert.equal(xWeightedLength("hello"), 5);
  assert.equal(xWeightedLength("🔥"), 2);
  assert.equal(xWeightedLength("👨‍👩‍👧‍👦"), 2, "one family emoji is one grapheme");
  assert.equal(xWeightedLength("日本語"), 6);
  assert.equal(xWeightedLength("see https://example.com/a/very/long/path?with=params"), 4 + 23);
  assert.equal(xWeightedLength("a\r\nb"), 3, "CRLF counts as one line break");
  assert.equal(normalizeReplyText("é"), "é", "NFC");
  assert.equal(checkReplyText("a".repeat(280)).ok, true);
  const over = checkReplyText("🔥".repeat(141));
  assert.equal(over.ok, false);
  assert.equal(over.length, 282);
  assert.equal(checkReplyText("\n  \n").ok, false);
});

let seq = 0;
async function opportunity(profileId: string, values: Partial<typeof s.opportunitiesTable.$inferInsert> = {}) {
  const [run] = await db.insert(s.scoutRunsTable).values({ profileId, status: "completed" }).returning();
  const [row] = await db
    .insert(s.opportunitiesTable)
    .values({
      scoutRunId: run.id,
      profileId,
      platform: "x",
      platformPostId: `19${Date.now()}${seq++}`.slice(0, 19),
      postUrl: "https://x.com/founder/status/1",
      authorHandle: "founder",
      content: "MVPs are dead. You can code anything in an afternoon now.",
      score: 82,
      status: "new",
      ...values,
    })
    .returning();
  const [draft] = await db
    .insert(s.repliesTable)
    .values({ opportunityId: row.id, variant: "natural", originalContent: "AI draft", content: "AI draft" })
    .returning();
  return { opportunity: row, draft };
}

const intentsOf = (opportunityId: string) =>
  db.select().from(s.replyIntentsTable).where(eq(s.replyIntentsTable.opportunityId, opportunityId));
const statusOf = async (id: string) =>
  (await db.select().from(s.opportunitiesTable).where(eq(s.opportunitiesTable.id, id)))[0].status;
const record = (profileId: string, opportunityId: string, replyId: string | null, text = "My edited reply 🚀") =>
  recordReplyIntent(profileId, { opportunityId, replyId, text, source: "x_web_intent", isValidPostId: isXPostId });

test("opening X records the attempt once, leaves the feed, never claims posted", async () => {
  const p = await newProfile();
  const { opportunity: o, draft } = await opportunity(p.id);
  const before = { ai: ai.calls.length, x: x.calls.length, slack: slack.calls.length };

  const result = await record(p.id, o.id, draft.id);
  assert.ok(result.ok);
  const [intent] = await intentsOf(o.id);
  assert.equal(intent.status, "opened");
  assert.equal(intent.source, "x_web_intent");
  assert.equal(intent.platformPostId, o.platformPostId, "the original X post, not Scout's id");
  assert.equal(intent.text, "My edited reply 🚀");
  assert.equal(intent.edited, true);
  assert.equal(intent.previousStatus, "new");
  assert.equal(await statusOf(o.id), "reply_opened", "not 'replied'");
  const [reply] = await db.select().from(s.repliesTable).where(eq(s.repliesTable.id, draft.id));
  assert.deepEqual([reply.content, reply.originalContent, reply.status], ["My edited reply 🚀", "AI draft", "approved"]);

  // Repeated and simultaneous clicks: still one history row
  await Promise.all([record(p.id, o.id, draft.id, "v2"), record(p.id, o.id, draft.id, "v3")]);
  const rows = await intentsOf(o.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].openCount, 3);
  assert.deepEqual({ ai: ai.calls.length, x: x.calls.length, slack: slack.calls.length }, before, "no API calls");

  // Unedited draft
  const second = await opportunity(p.id);
  await record(p.id, second.opportunity.id, second.draft.id, "AI draft");
  assert.equal((await intentsOf(second.opportunity.id))[0].edited, false);
});

test("ownership and validation: other users' opportunities and non-X posts are refused", async () => {
  const owner = await newProfile();
  const intruder = await newProfile();
  const { opportunity: o, draft } = await opportunity(owner.id);
  assert.deepEqual(await record(intruder.id, o.id, draft.id), { ok: false, reason: "not_found" });
  assert.equal((await intentsOf(o.id)).length, 0);
  assert.equal(await statusOf(o.id), "new");

  const bad = await opportunity(owner.id, { platformPostId: "imported-abc" });
  assert.deepEqual(await record(owner.id, bad.opportunity.id, bad.draft.id), { ok: false, reason: "not_an_x_post" });

  // A draft from another opportunity is ignored, not edited
  const other = await opportunity(owner.id);
  assert.ok((await record(owner.id, o.id, other.draft.id)).ok);
  assert.equal((await intentsOf(o.id))[0].replyId, null);
  const [untouched] = await db.select().from(s.repliesTable).where(eq(s.repliesTable.id, other.draft.id));
  assert.equal(untouched.content, "AI draft");

  // Activity actions only on one's own opportunities
  assert.equal(await confirmReplyPosted(intruder.id, o.id), false);
  assert.equal(await returnToFeed(intruder.id, o.id), false);
  assert.equal(await statusOf(o.id), "reply_opened");
});

test("feed hides opened replies; Activity shows them; confirm and return are optional", async () => {
  const p = await newProfile();
  const opened = await opportunity(p.id, { score: 90 });
  const saved = await opportunity(p.id, { status: "saved", score: 85 });
  const untouched = await opportunity(p.id, { score: 70 });
  await record(p.id, opened.opportunity.id, opened.draft.id);
  await record(p.id, saved.opportunity.id, saved.draft.id);

  const feed = (filter: "all" | "new" | "saved") => getOpportunities(p.id, filter).then((rows) => rows.map((r) => r.id));
  assert.deepEqual(await feed("all"), [untouched.opportunity.id]);
  assert.deepEqual(await feed("new"), [untouched.opportunity.id]);
  assert.deepEqual(await feed("saved"), []);

  const activity = await getReplyActivity(p.id);
  assert.deepEqual(new Set(activity.map((a) => a.opportunity.id)), new Set([opened.opportunity.id, saved.opportunity.id]));
  assert.ok(activity.every((a) => a.intent.status === "opened"));

  // Mark as posted: self-reported; a later click keeps it confirmed
  assert.equal(await confirmReplyPosted(p.id, opened.opportunity.id), true);
  assert.equal(await statusOf(opened.opportunity.id), "replied");
  await record(p.id, opened.opportunity.id, opened.draft.id, "again");
  assert.equal((await intentsOf(opened.opportunity.id))[0].status, "confirmed");
  assert.equal(await statusOf(opened.opportunity.id), "replied", "never downgraded");
  assert.equal(await returnToFeed(p.id, opened.opportunity.id), false, "a confirmed reply isn't returned");

  // Return to opportunities: back as it was (saved), gone from Activity
  assert.equal(await returnToFeed(p.id, saved.opportunity.id), true);
  assert.equal(await statusOf(saved.opportunity.id), "saved");
  assert.deepEqual(await feed("saved"), [saved.opportunity.id]);
  assert.deepEqual((await getReplyActivity(p.id)).map((a) => a.opportunity.id), [opened.opportunity.id]);
  // Reopened later: back in Activity, out of the feed
  await record(p.id, saved.opportunity.id, saved.draft.id);
  assert.equal(await statusOf(saved.opportunity.id), "reply_opened");

  const stats = await getReplyIntentStats(p.id);
  assert.deepEqual([stats.opened, stats.confirmed, stats.reopened], [2, 1, 2]);
});
