// Day 22 onboarding: progress derived from saved data, existing users kept
// out, the accounts step and the first scan. X and OpenAI are mocked; the
// database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getProfileById } from "@/db/queries/profiles";
import * as s from "@/db/schema";
import {
  canComplete,
  explainScore,
  hasRequiredAnswers,
  joinList,
  onboardingEntry,
  type OnboardingFacts,
  resumeStep,
  splitList,
} from "@/lib/onboarding/progress";
import { onboardingSchema } from "@/schemas/onboarding";
import { getOnboardingFacts } from "@/services/onboarding/facts";
import { runScout } from "@/services/scout/runScout";
import { addWatchlistAccount } from "@/services/watchlist/addAccount";

import { ageRuns, cleanup, newProfile, rememberXUsage, trackXUser } from "./helpers/db";
import { addTweets, ai, installMocks, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

const facts = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  completed: false,
  started: false,
  answered: false,
  mode: "scratch",
  voiceSamples: 0,
  hasBrain: false,
  activeAccounts: 0,
  ...overrides,
});

test("new users start at the welcome screen and resume where their data is", () => {
  assert.equal(resumeStep(facts()), "welcome");
  assert.equal(resumeStep(facts({ started: true })), "connect");
  assert.equal(resumeStep(facts({ started: true, answered: true })), "voice");
  assert.equal(resumeStep(facts({ started: true, answered: true, voiceSamples: 3 })), "brain");
  assert.equal(resumeStep(facts({ started: true, answered: true, mode: "posts" })), "brain", "no voice step with posts");
  assert.equal(resumeStep(facts({ answered: true, hasBrain: true })), "accounts");
  assert.equal(resumeStep(facts({ answered: true, hasBrain: true, activeAccounts: 3 })), "accounts", "confirmed, not assumed");

  // Opening a later step than the saved progress lands on the saved step
  assert.deepEqual(onboardingEntry(facts({ started: true }), "scan"), { step: "connect" });
  assert.deepEqual(onboardingEntry(facts({ answered: true, hasBrain: true }), "answers"), { step: "answers" }, "going back is fine");
  assert.deepEqual(onboardingEntry(facts(), "nonsense"), { step: "welcome" });
  assert.deepEqual(onboardingEntry(facts({ answered: true }), "accounts"), { step: "voice" });

  // Finished users: dashboard, unless they open a step on purpose (Settings)
  assert.deepEqual(onboardingEntry(facts({ completed: true }), null), { redirect: "/dashboard" });
  assert.deepEqual(onboardingEntry(facts({ completed: true }), "answers"), { step: "answers" });

  assert.equal(canComplete({ hasBrain: true, activeAccounts: 0 }), false);
  assert.equal(canComplete({ hasBrain: false, activeAccounts: 4 }), false);
  assert.equal(canComplete({ hasBrain: true, activeAccounts: 1 }), true);
});

test("answers: chips are stored in the existing fields and validated server-side", () => {
  assert.deepEqual(splitList("AI, SaaS,  ai ,\nDesign"), ["AI", "SaaS", "Design"]);
  assert.equal(joinList(["Grow my audience", "Build authority", "grow my audience"]), "Grow my audience, Build authority");
  const answers = {
    displayName: "Ana",
    xHandle: "",
    occupation: "Building an AI SaaS",
    bio: "",
    targetAudience: "Founders",
    primaryGoal: joinList(["Grow my audience", "Build authority", "Find potential customers", "Network with interesting people", "Drive traffic to my product", "Build in public"]),
    knownFor: "",
    topics: "AI, SaaS",
    avoidTopics: "",
    voiceDescription: "Direct and practical",
  };
  assert.ok(onboardingSchema.safeParse(answers).success, "all six goals fit");
  assert.equal(onboardingSchema.safeParse({ ...answers, topics: " " }).success, false, "topics required");
  assert.ok(hasRequiredAnswers({ ...answers, voiceDescription: "Witty" }));
  assert.equal(hasRequiredAnswers({ ...answers, occupation: null }), false);

  assert.equal(
    explainScore(82, { relevance: 23, goalAlignment: 10, expertiseFit: 8, freshness: 15, audienceValue: 4, novelty: 2 }),
    "82/100: mostly because the conversation is fresh and it's about topics you know.",
  );
  assert.equal(explainScore(55, { relevance: 10, goalAlignment: 8, expertiseFit: 8, freshness: 7, audienceValue: 4, novelty: 4 }), "55/100: a moderate match on several factors.");
});

async function bareProfile() {
  // A fresh sign-up: no answers, no Brain (newProfile() comes with a Brain)
  const p = await newProfile();
  await db
    .update(s.profilesTable)
    .set({ voiceBrain: null, interestBrain: null, goalBrain: null })
    .where(eq(s.profilesTable.id, p.id));
  return (await getProfileById(p.id))!;
}

test("facts come from saved data; existing finished users go to the dashboard", async () => {
  const fresh = await bareProfile();
  const f = await getOnboardingFacts(fresh);
  assert.deepEqual(
    { started: f.started, answered: f.answered, hasBrain: f.hasBrain, activeAccounts: f.activeAccounts, completed: f.completed },
    { started: false, answered: false, hasBrain: false, activeAccounts: 0, completed: false },
  );
  assert.deepEqual(onboardingEntry(f, null), { step: "welcome" });

  await db
    .update(s.profilesTable)
    .set({ occupation: "Founder", topics: "AI", primaryGoal: "Grow my audience", targetAudience: "Founders", voiceDescription: "Direct" })
    .where(eq(s.profilesTable.id, fresh.id));
  const answered = await getOnboardingFacts((await getProfileById(fresh.id))!);
  assert.deepEqual(onboardingEntry(answered, null), { step: "voice" }, "a refresh or new session resumes here");

  // An existing, finished profile keeps its data and never re-enters setup
  const existing = await newProfile();
  await db.update(s.profilesTable).set({ onboardingCompleted: true }).where(eq(s.profilesTable.id, existing.id));
  const done = await getOnboardingFacts((await getProfileById(existing.id))!);
  assert.deepEqual(onboardingEntry(done, null), { redirect: "/dashboard" });
});

test("accounts step: verified adds, duplicates refused, isolated per user", async () => {
  const a = await newProfile();
  const b = await newProfile();
  const userId = `9${Date.now()}`;
  x.users.set("founderana", userId);
  trackXUser(userId);

  const added = await addWatchlistAccount(a.id, "founderana");
  assert.equal(added.status, "added");
  assert.deepEqual(await addWatchlistAccount(a.id, "FounderAna"), { status: "duplicate", handle: "founderana" });
  assert.equal((await addWatchlistAccount(a.id, "nobody_here")).status, "not_found");
  // The same X account on another user's list is theirs alone
  assert.equal((await addWatchlistAccount(b.id, "founderana")).status, "added");
  const facts = await getOnboardingFacts((await getProfileById(a.id))!);
  assert.equal(facts.activeAccounts, 1);
  assert.equal(canComplete(facts), true);
  x.users.delete("founderana");
});

test("first scan: runs for a user without history, then the existing limits apply", async () => {
  const p = await newProfile();
  const userId = `8${Date.now()}`;
  x.users.set("firstscan", userId);
  addTweets(userId, 3);
  trackXUser(userId);
  assert.equal((await addWatchlistAccount(p.id, "firstscan")).status, "added");

  // Two clicks at once: one scan, never two
  const aiBefore = ai.calls.length;
  const [first, second] = await Promise.all([runScout(p.id), runScout(p.id)]);
  const statuses = [first.status, second.status].sort();
  assert.ok(statuses.includes("completed"), JSON.stringify(statuses));
  assert.equal(statuses.filter((status) => status === "completed").length, 1);
  assert.ok(ai.calls.length > aiBefore, "scored with the (mocked) model");

  // Right after: testing-mode spacing refuses another paid scan
  const again = await runScout(p.id);
  assert.equal(again.status, "limited");
  assert.ok(again.status === "limited" && again.gate.nextEligibleAt, "with the time of the next allowed scan");

  // Once allowed again it runs, and nothing new means no paid scoring
  await ageRuns(p.id);
  const later = await runScout(p.id);
  assert.equal(later.status, "completed");
  assert.ok(later.status === "completed" && later.stats.candidates === 0);
  x.users.delete("firstscan");
});

test("scans refuse users with nothing to watch", async () => {
  const p = await newProfile();
  assert.equal((await runScout(p.id)).status, "no_active_accounts");

});
