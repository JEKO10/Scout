// Day 31 Content Studio: X character counting, ideas and drafts from the
// Scout Brain and cached trend data, one-post edits, reviews, drafts as
// structured threads, budget and pacing, and user isolation. OpenAI is mocked;
// the database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getDraft, getDrafts } from "@/db/queries/content";
import { getTrends } from "@/db/queries/trends";
import * as s from "@/db/schema";
import { countXChars, xIntentUrl } from "@/lib/content/types";
import {
  confirmPublished,
  createDraft,
  duplicateDraft,
  generateIdeas,
  removeDraft,
  reviewDraft,
  rewritePost,
  saveDraftEdits,
} from "@/services/content/studio";
import { runScout } from "@/services/scout/runScout";

import { cleanup, getProfile, newProfile, rememberXUsage, setOverrides, watch } from "./helpers/db";
import { addTweets, ai, installMocks } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

/** Content Studio allows one AI request every few seconds: tests move time on */
async function pace(profileId: string) {
  await db
    .update(s.aiUsageTable)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(s.aiUsageTable.profileId, profileId));
}

const lastInput = () => JSON.parse(String(ai.requests.at(-1)?.input ?? "{}"));

test("X character counting: links count 23, emoji 2", () => {
  assert.equal(countXChars("hello"), 5);
  assert.equal(countXChars("see https://example.com/a/very/long/path?x=1"), 4 + 23);
  assert.equal(countXChars("🚀"), 2);
  assert.ok(xIntentUrl("a & b").includes("text=a%20%26%20b"));
});

test("ideas: personalized from the Brain, at most five, paced", async () => {
  const p = await newProfile();
  const ideas = await generateIdeas(p, { goal: "build_authority", topic: "first customers" });
  assert.ok(ideas.ok && ideas.ideas.length === 5, "capped at five");
  const input = lastInput();
  assert.ok(input.user, "the user's profile is in the prompt");
  assert.equal(input.goal.id, "build_authority");

  const again = await generateIdeas(p, { goal: "build_authority" });
  assert.equal(again.ok, false, "a second request right away is refused");
  assert.equal((await generateIdeas(p, { goal: "nonsense" as "educate" })).ok, false);
});

test("drafts: posts and threads stored as separate posts; one-post edits leave the rest", async () => {
  const p = await newProfile();
  assert.equal((await createDraft(p, { goal: "educate", format: "post", tone: "bold", length: "short" })).ok, false, "needs a topic or idea");

  const post = await createDraft(p, { goal: "educate", format: "post", tone: "bold", length: "short", topic: "first customers" });
  assert.ok(post.ok);
  const single = await getDraft(p.id, post.ok ? post.draftId : "");
  assert.equal(single?.posts.length, 1);

  await pace(p.id);
  const thread = await createDraft(p, { goal: "grow_audience", format: "thread", tone: "conversational", length: "medium", topic: "first customers" });
  assert.ok(thread.ok);
  const id = thread.ok ? thread.draftId : "";
  const draft = (await getDraft(p.id, id))!;
  assert.equal(draft.posts.length, 3, "a thread keeps its posts apart");
  assert.ok(draft.posts.some((text) => text.includes("[your example")), "placeholders instead of invented experience");

  await pace(p.id);
  const rewritten = await rewritePost(p, id, 1, "shorten");
  assert.ok(rewritten.ok);
  const after = (await getDraft(p.id, id))!;
  assert.equal(after.posts[1], "A sharper version of this post.");
  assert.equal(after.posts[0], draft.posts[0], "other posts untouched");
  assert.equal(after.posts[2], draft.posts[2]);
  assert.match(String(ai.requests.at(-1)?.instructions), /Rewrite only the post marked/);

  await pace(p.id);
  assert.equal((await rewritePost(p, id, 9, "shorten")).ok, false, "no such post");
  assert.equal((await rewritePost(p, id, 0, "make it viral")).ok, false, "unknown edit");
});

test("review: on request, at most three improvements, stored with the draft", async () => {
  const p = await newProfile();
  const created = await createDraft(p, { goal: "educate", format: "post", tone: "educational", length: "medium", topic: "pricing" });
  const id = created.ok ? created.draftId : "";
  await pace(p.id);
  const review = await reviewDraft(p, id);
  assert.ok(review.ok && review.review.improvements.length === 3);
  assert.ok(review.ok && review.review.revised?.length === 1, "a post's revision stays one post");
  assert.equal((await getDraft(p.id, id))?.review?.assessment, "Clear point, but the hook is generic.");
});

test("manual edits, statuses, duplicates, search, publishing confirmation and isolation", async () => {
  const p = await newProfile();
  const other = await newProfile();
  const created = await createDraft(p, { goal: "educate", format: "thread", tone: "educational", length: "short", topic: "onboarding" });
  const id = created.ok ? created.draftId : "";

  assert.equal((await saveDraftEdits(p, id, { title: "Onboarding thread", posts: ["One", "  ", "Two"], status: "ready" })).ok, true);
  const saved = (await getDraft(p.id, id))!;
  assert.deepEqual(saved.posts, ["One", "Two"], "empty posts dropped, order kept");
  assert.equal(saved.status, "ready");
  assert.equal((await saveDraftEdits(p, id, { title: "x", posts: Array(16).fill("a"), status: "draft" })).ok, false, "thread limit");
  assert.equal((await saveDraftEdits(p, id, { title: "", posts: ["a"], status: "draft" })).ok, false);

  const copy = await duplicateDraft(p, id);
  assert.ok(copy.ok);
  assert.equal((await getDrafts(p.id, { q: "Onboarding" })).length, 2);
  assert.equal((await getDrafts(p.id, { status: "ready" })).length, 1, "the copy starts as a draft");

  assert.equal(saved.publishedConfirmedAt, null, "nothing is marked posted on its own");
  await confirmPublished(p, id);
  assert.ok((await getDraft(p.id, id))?.publishedConfirmedAt);

  assert.equal(await getDraft(other.id, id), undefined, "another user can't read it");
  assert.equal((await saveDraftEdits(other, id, { title: "x", posts: ["x"], status: "draft" })).ok, false);
  assert.equal((await rewritePost(other, id, 0, "shorten")).ok, false);
  assert.equal((await removeDraft(other, id)).ok, false);
  assert.equal((await removeDraft(p, id)).ok, true);
});

test("budget: no writing budget, no AI call", async () => {
  const p = await newProfile({ monthlyReplyUsd: 0.001 });
  const calls = ai.calls.length;
  const result = await generateIdeas(p, { goal: "educate" });
  assert.equal(result.ok, false);
  assert.equal(ai.calls.length, calls);
  await setOverrides(p.id, { monthlyReplyUsd: 3 });
  assert.ok((await generateIdeas(await getProfile(p.id), { goal: "educate" })).ok);
});

test("from a trend: only its stored data goes in; another user's trend is refused", async () => {
  const p = await newProfile();
  const other = await newProfile();
  const users = [`c${Date.now()}a`, `c${Date.now()}b`];
  for (const user of users) addTweets(user, 2);
  await watch(p.id, users);
  await runScout(p.id);
  const [trend] = await getTrends(p.id, {});
  await pace(p.id);

  const ideas = await generateIdeas(await getProfile(p.id), { goal: "build_authority", trendId: trend.id });
  assert.ok(ideas.ok);
  const input = lastInput();
  assert.equal(input.trends.length, 1);
  assert.equal(input.trends[0].title, trend.label);
  assert.equal(input.trends[0].observed, trend.summary);

  assert.equal((await generateIdeas(other, { goal: "educate", trendId: trend.id })).ok, false);
});
