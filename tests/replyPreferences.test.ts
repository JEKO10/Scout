// Reply preferences: matching, conflicts, the offline evaluation and storage
// apart from the Brain. No network; the database is the test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { getProfileById, saveReplyPreferences, updateProfileBrain } from "@/db/queries/profiles";
import { evaluatePreferences } from "@/lib/evals/scoring/preferenceEval";
import type { EvalDataset, EvalRun, ReviewLabels } from "@/lib/evals/scoring/types";
import {
  applyPreferenceNudge,
  detectPreferenceConflicts,
  matchPreference,
  normalizeReplyPreferences,
} from "@/lib/scout/replyPreferences";

import { cleanup, newProfile, rememberXUsage } from "./helpers/db";

before(rememberXUsage);
after(cleanup);

test("preferences are trimmed, de-duplicated and limited", () => {
  const prefs = normalizeReplyPreferences({
    want: ["  AI coding  takes ", "ai coding takes", "", ...Array.from({ length: 20 }, (_, i) => `topic ${i}`)],
    avoid: ["x".repeat(300)],
  });
  assert.equal(prefs.want[0], "AI coding takes");
  assert.equal(prefs.want.filter((item) => item.toLowerCase() === "ai coding takes").length, 1);
  assert.equal(prefs.want.length, 10);
  assert.equal(prefs.avoid[0].length, 120);
  assert.deepEqual(normalizeReplyPreferences(null), { want: [], avoid: [] });
});

test("broad or overlapping avoid entries are flagged against positive interests", () => {
  // The real case: onboarding avoid list vs the cold-start Brain topics
  const conflicts = detectPreferenceConflicts({
    positive: ["AI", "Startups", "Software", "Design", "Growing on X", "SaaS"],
    avoidTopics: "Saas news, software news, everything related to tech",
    preferences: { want: [], avoid: ["follower milestones"] },
  });
  assert.deepEqual(
    conflicts.map((c) => [c.avoid, c.reason]),
    [
      ["Saas news", "same_words"],
      ["software news", "same_words"],
      ["everything related to tech", "too_broad"],
    ],
  );
  const broad = conflicts.find((c) => c.reason === "too_broad")!;
  assert.ok(broad.conflictsWith.includes("AI") && broad.conflictsWith.includes("Software"));
  assert.equal(broad.source, "avoidTopics");

  // Specific avoid entries don't conflict
  assert.deepEqual(
    detectPreferenceConflicts({
      positive: ["AI coding tools", "SaaS pricing"],
      avoidTopics: null,
      preferences: { want: ["takes on AI coding"], avoid: ["newsletter tool promos", "follower milestones"] },
    }),
    [],
  );
  // A wanted item contradicted by an avoid item
  const own = detectPreferenceConflicts({
    positive: ["AI benchmarks"],
    avoidTopics: null,
    preferences: { want: ["AI benchmarks"], avoid: ["AI model benchmarks"] },
  });
  assert.equal(own[0]?.source, "replyPreferences.avoid");
});

test("matching keeps short subject words and folds plurals", () => {
  assert.equal(matchPreference("Gemini is slow for AI agents", ["AI coding", "design"]), "AI coding");
  assert.equal(matchPreference("New products every week", ["product launches"]), "product launches");
  assert.equal(matchPreference("What do you think about this?", ["AI coding"]), null);
  assert.equal(matchPreference("AI art is wild", ["AI coding tools"], 2), null, "needs two shared words");
});

test("nudges raise wanted and lower unwanted posts, within 0–100", () => {
  const prefs = { want: ["AI coding"], avoid: ["newsletter promos"] };
  const nudge = { wantPoints: 10, avoidPoints: 15, minOverlap: 1, wantOverridesEngage: false };
  const wanted = applyPreferenceNudge({ text: "AI coding is changing review", score: 55, shouldEngage: true }, prefs, nudge, 60);
  assert.deepEqual([wanted.score, wanted.surfaced], [65, true]);
  const unwanted = applyPreferenceNudge({ text: "Our newsletter promos are live", score: 70, shouldEngage: true }, prefs, nudge, 60);
  assert.deepEqual([unwanted.score, unwanted.surfaced], [55, false]);
  assert.equal(applyPreferenceNudge({ text: "AI coding", score: 95, shouldEngage: true }, prefs, nudge, 60).score, 100);

  // shouldEngage is overridden only when allowed, and never for an avoided post
  const notEngaged = { text: "AI coding take", score: 70, shouldEngage: false };
  assert.equal(applyPreferenceNudge(notEngaged, prefs, nudge, 60).surfaced, false);
  assert.equal(applyPreferenceNudge(notEngaged, prefs, { ...nudge, wantOverridesEngage: true }, 60).surfaced, true);
  const both = { text: "AI coding newsletter promos", score: 70, shouldEngage: false };
  assert.equal(applyPreferenceNudge(both, prefs, { ...nudge, wantOverridesEngage: true }, 60).surfaced, false);
});

test("offline evaluation: a post is never predicted with its own label", () => {
  const profileKey = "profile-1";
  const make = (id: string, content: string, score: number, label: ReviewLabels[string]["label"]) => ({
    example: {
      id,
      profileKey,
      input: { candidateId: id, authorHandle: "a", kind: "post", hoursAgo: 1, replies: 0, content, history: [] },
      freshness: 15,
      postedAt: new Date().toISOString(),
      url: "https://x.com/a/status/1",
      strata: ["medium"],
      original: { score, breakdown: null, shouldEngage: true, reason: null, suggestedAngle: null, topic: null, surfaced: false, opportunityStatus: null, userLabel: null },
    },
    outcome: { id, score, shouldEngage: true, surfaced: false, reason: null, suggestedAngle: null, topic: null, stage: null, prefiltered: null },
    label,
  });
  const rows = [
    // Only this post mentions "quantum": it can only "learn" from itself
    make("00000000-0000-4000-8000-000000000001", "quantum annealing hardware roadmap", 55, "strong"),
    make("00000000-0000-4000-8000-000000000002", "AI coding agents review pull requests", 70, "strong"),
    make("00000000-0000-4000-8000-000000000003", "AI coding agents write tests now", 58, "acceptable"),
    make("00000000-0000-4000-8000-000000000004", "newsletter promo discount code today", 72, "irrelevant"),
    make("00000000-0000-4000-8000-000000000005", "newsletter promo launch week sale", 65, "weak"),
  ];
  const dataset = {
    version: 1,
    exportedAt: "",
    profiles: { [profileKey]: { brain: {}, userWriting: [], threshold: 60 } },
    examples: rows.map((row) => row.example),
  } as unknown as EvalDataset;
  const run = { outcomes: rows.map((row) => row.outcome) } as unknown as EvalRun;
  const labels: ReviewLabels = Object.fromEntries(rows.map((row) => [row.example.id, { label: row.label }]));

  const result = evaluatePreferences(dataset, labels, run, profileKey, { kind: "ratings" });
  const quantum = result.chosen.find((c) => c.id.endsWith("1"))!;
  assert.equal(quantum.after, quantum.before, "no other post shares its words, so nothing changes");
  assert.equal(result.baseline.n, 5);
  // Baseline: strong 70, irrelevant 72 and weak 65 surface; acceptable 58 and strong 55 don't
  assert.deepEqual(result.baseline.strongRecall, [1, 2]);
  assert.equal(result.baseline.irrelevantSurfaced, 1);
});

test("reply preferences survive a Brain rebuild and stay apart from lowConfidenceTopics", async () => {
  const p = await newProfile();
  await saveReplyPreferences(p.id, { want: ["AI coding takes"], avoid: ["newsletter promos"] });
  const before = (await getProfileById(p.id))!;
  const lowConfidence = (before.interestBrain as unknown as { data: { lowConfidenceTopics: unknown } }).data
    .lowConfidenceTopics;

  // Rebuild the Brain with its own data, as a new analysis would
  const data = (brain: unknown) => (brain as { data: unknown }).data;
  await updateProfileBrain(p.id, {
    analysis: {
      voice: data(before.voiceBrain),
      interests: data(before.interestBrain),
      goals: data(before.goalBrain),
    } as Parameters<typeof updateProfileBrain>[1]["analysis"],
    measured: (before.voiceBrain as unknown as { measured: Parameters<typeof updateProfileBrain>[1]["measured"] }).measured,
    postCount: 5,
    holdoutPostIds: [],
    model: "test",
  });

  const afterRebuild = (await getProfileById(p.id))!;
  assert.deepEqual(afterRebuild.replyPreferences, { want: ["AI coding takes"], avoid: ["newsletter promos"] });
  const lowAfter = (afterRebuild.interestBrain as unknown as { data: { lowConfidenceTopics: unknown } }).data
    .lowConfidenceTopics;
  assert.deepEqual(lowAfter, lowConfidence, "avoid never goes into lowConfidenceTopics");
});
