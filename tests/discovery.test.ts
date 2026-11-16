// Day 26 Smart Discovery: safe queries, topic limits and ownership, searches
// inside the normal scan (same budget, same scoring), deduplication with the
// watchlist and no repeated X or AI work. X and OpenAI are mocked; the
// database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getDiscoveryFeed, getDiscoveryTopics } from "@/db/queries/discovery";
import * as s from "@/db/schema";
import { buildSearchQuery, cleanKeyword, MAX_QUERY_LENGTH } from "@/lib/discovery/query";
import { getScoutLimits } from "@/lib/scout/testLimits";
import { createTopic, removeTopic, setTopicActive, updateTopic } from "@/services/discovery/topics";
import { planFetchCaps, runScout } from "@/services/scout/runScout";

import { ageRuns, cleanup, newProfile, rememberXUsage, watch } from "./helpers/db";
import { addSearchResults, addTweets, ai, installMocks, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(async () => {
  x.search = [];
  await cleanup();
});

const topicInput = (name = "SaaS customer acquisition") => ({
  name,
  description: "Founders discussing difficulties acquiring their first customers.",
  keywords: ["first customers", "customer acquisition", "finding users"],
  excludedKeywords: ["hiring"],
});

test("queries: plain keywords only, operators stripped, within X's limits", () => {
  assert.equal(cleanKeyword('from:elonmusk "quoted" (group)'), "from elonmusk quoted group");
  assert.equal(cleanKeyword("-spam"), "spam");
  assert.equal(cleanKeyword("OR"), "");

  const query = buildSearchQuery(
    { keywords: ["first customers", "SaaS", "saas", "url:evil"], excludedKeywords: ["hiring", "crypto giveaway"] },
    { language: "en" },
  );
  assert.equal(query, '("first customers" OR SaaS OR "url evil") -hiring -"crypto giveaway" -is:retweet -is:reply -is:quote lang:en');
  assert.equal(buildSearchQuery({ keywords: ["  ", "()"], excludedKeywords: [] }), null, "nothing to search");

  const long = buildSearchQuery({ keywords: Array.from({ length: 8 }, (_, i) => `${"word".repeat(9)}${i}`), excludedKeywords: [] });
  assert.ok(long && long.length <= MAX_QUERY_LENGTH);
});

test("topics: validated, limited by plan, owned by their user", async () => {
  const p = await newProfile({ maxDiscoveryTopics: 1 });
  const other = await newProfile();

  assert.equal((await createTopic(p, { ...topicInput(), keywords: [] })).ok, false, "a keyword is required");
  assert.equal((await createTopic(p, topicInput())).ok, true);
  const second = await createTopic(p, topicInput("Pricing"));
  assert.equal(second.ok, true);
  assert.match(second.ok ? (second.message ?? "") : "", /paused/);

  const [first, paused] = await getDiscoveryTopics(p.id);
  assert.equal(first.isActive, true);
  assert.equal(paused.isActive, false);
  assert.equal((await setTopicActive(p, paused.id, true)).ok, false, "the plan allows one active topic");

  // Another user can't touch them
  assert.equal((await updateTopic(other, first.id, topicInput("Hijacked"))).ok, false);
  assert.equal((await removeTopic(other, first.id)).ok, false);
  assert.equal((await setTopicActive(other, first.id, false)).ok, false);
  assert.equal((await getDiscoveryTopics(p.id))[0].name, "SaaS customer acquisition");
});

test("budget: topics share the scan's X budget with the watchlist", () => {
  const limits = getScoutLimits("free");
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const caps = planFetchCaps([{ id: "acc", lastScannedAt: at(5) }], 25, limits, [{ id: "topic", lastSearchedAt: null }]);
  // 25 resources: enough for a search page and a small account page
  assert.ok((caps.get("topic") ?? 0) >= 10, "the never-searched topic gets at least a search page");
  const total = [...caps.entries()].reduce((sum, [id, cap]) => sum + cap * (id === "acc" ? 2 : 1), 0);
  assert.ok(total <= 25, "never above the budget");
  assert.equal(planFetchCaps([], 9, limits, [{ id: "t", lastSearchedAt: null }]).get("t"), 0, "less than a search page: skipped");
});

test("scan: a topic search feeds the same scoring, once per post, tagged with its source", async () => {
  const p = await newProfile();
  await createTopic(p, topicInput());
  const [topic] = await getDiscoveryTopics(p.id);
  const author = `d${Date.now()}`;
  const found = addSearchResults(author, 3);

  // The same post also arrives from a watched account: scored once
  const watched = `w${Date.now()}`;
  addTweets(watched, 2);
  await watch(p.id, [watched]);

  const aiBefore = ai.calls.length;
  const result = await runScout(p.id);
  assert.equal(result.status, "completed");
  assert.ok(x.searchQueries.at(-1)?.includes('"first customers"'), "searched the topic's keywords");
  assert.ok(ai.calls.length > aiBefore, "scored with the shared pipeline");

  const candidates = await db.select().from(s.scoutCandidatesTable).where(eq(s.scoutCandidatesTable.profileId, p.id));
  for (const id of found) {
    const row = candidates.find((candidate) => candidate.platformPostId === id);
    assert.equal(row?.discoveryTopicId, topic.id);
    assert.equal(row?.source, "x_search");
  }
  if (result.status === "completed") {
    assert.ok((result.stats.planXReads ?? 0) >= found.length, "search results are charged to the user's X budget");
  }

  const feed = await getDiscoveryFeed(p.id, {});
  assert.ok(feed.length > 0 && feed.every((item) => item.discoveryTopicId === topic.id));

  // Next scan: only newer posts are asked for; nothing seen is scored again
  await ageRuns(p.id);
  const scored = ai.calls.length;
  const again = await runScout(p.id);
  assert.equal(again.status, "completed");
  assert.equal(ai.calls.length, scored, "no new posts: no AI calls");
  const [searched] = await getDiscoveryTopics(p.id);
  assert.ok(searched.sinceId && searched.lastSearchedAt);
});

test("topics alone are enough to scan; paused topics aren't searched; no budget, no search", async () => {
  const p = await newProfile();
  await createTopic(p, topicInput());
  const [topic] = await getDiscoveryTopics(p.id);
  addSearchResults(`e${Date.now()}`, 2);

  await setTopicActive(p, topic.id, false);
  assert.equal((await runScout(p.id)).status, "no_active_accounts", "nothing active, nothing searched");

  await setTopicActive(p, topic.id, true);
  const tight = await newProfile({ monthlyXPostReads: 5 });
  await createTopic(tight, topicInput());
  const queries = x.searchQueries.length;
  const result = await runScout(tight.id);
  assert.equal(result.status, "completed", JSON.stringify(result.status === "failed" ? result.error : result.status));
  assert.equal(x.searchQueries.length, queries, "5 posts can't pay for a search page: not searched");
});
