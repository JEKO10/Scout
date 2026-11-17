// Day 28 Lead Scout CRM: saving (with the plan's limit), statuses, notes,
// follow-ups, logged interactions, the next-best-action rules, metrics, user
// isolation, and rescans that never overwrite CRM data. X and OpenAI are
// mocked; the database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getCrmLead, getCrmLeads, getCrmMetrics, getFollowUps } from "@/db/queries/crm";
import { getLeads, insertLeads } from "@/db/queries/leads";
import * as s from "@/db/schema";
import { followUpState, nextBestAction } from "@/lib/leads/crm";
import {
  addNote,
  changeLeadStatus,
  editNote,
  finishFollowUp,
  logInteraction,
  removeLead,
  removeNote,
  saveLeadToCrm,
  scheduleFollowUp,
} from "@/services/leads/crm";
import { saveIcp } from "@/services/leads/icp";
import { runScout } from "@/services/scout/runScout";

import { ageRuns, cleanup, getProfile, newProfile, rememberXUsage, watch } from "./helpers/db";
import { addTweets, installMocks } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);

async function leadFor(profileId: string, handle = "founder") {
  const postId = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  await insertLeads([
    {
      profileId,
      platform: "x",
      platformPostId: postId,
      authorPlatformUserId: `u-${handle}`,
      authorHandle: handle,
      postUrl: `https://x.com/${handle}/status/${postId}`,
      content: "Any recommendations for a tool to find first customers?",
      postedAt: new Date(Date.now() - 3600_000),
      intent: "high",
      score: 82,
      scoreBreakdown: { icpFit: 25, intentStrength: 30, problemFit: 15, evidence: 7, recency: 5 },
      evidence: "recommendations for a tool",
      reason: "Asking for a tool.",
      suggestedAction: "Share what worked.",
    },
  ]);
  const leads = await getLeads(profileId, {});
  return leads.find((lead) => lead.platformPostId === postId)!;
}

test("next best action: grounded rules, most pressing first, nothing for closed leads", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const base = {
    status: "new" as const,
    intent: "high" as const,
    postedAt: new Date("2026-11-16T08:00:00Z"),
    followUpAt: null,
    followUpDoneAt: null,
    lastActivityAt: null,
    activityKinds: [] as string[],
  };
  assert.match(nextBestAction(base, now)!.text, /actively looking/);
  assert.match(nextBestAction({ ...base, postedAt: new Date("2026-11-10T08:00:00Z") }, now)!.text, /6 days old/);
  assert.equal(
    nextBestAction({ ...base, status: "contacted", lastActivityAt: new Date("2026-11-12T12:00:00Z"), activityKinds: ["status_changed"] }, now)!.tone,
    "suggest",
  );
  assert.match(nextBestAction({ ...base, followUpAt: new Date("2026-11-14T12:00:00Z") }, now)!.text, /2 day\(s\) ago/);
  assert.equal(nextBestAction({ ...base, status: "won" }, now), null);
  assert.equal(followUpState(new Date("2026-11-16T12:00:00Z"), null, now), "today");
  assert.equal(followUpState(new Date("2026-11-16T12:00:00Z"), new Date("2026-11-16T13:00:00Z"), now), "none", "done");
});

test("saving: plan limit, saved activity, removing keeps notes and history", async () => {
  const p = await newProfile({ maxSavedLeads: 1 });
  const first = await leadFor(p.id, "one");
  const second = await leadFor(p.id, "two");

  assert.equal((await saveLeadToCrm(p, first.id, true)).ok, true);
  const limited = await saveLeadToCrm(p, second.id, true);
  assert.equal(limited.ok, false, "the plan keeps one");

  await addNote(p, first.id, "Met at the meetup");
  assert.equal((await saveLeadToCrm(p, first.id, false)).ok, true);
  const kept = await getCrmLead(p.id, first.id);
  assert.equal(kept?.notes.length, 1, "notes survive removal");
  assert.ok(kept?.activities.some((a) => a.kind === "saved"));
  assert.equal((await getCrmLeads(p.id, {})).length, 0, "not in the CRM views anymore");
});

test("status, notes, follow-ups and interactions; other users can't touch them", async () => {
  const p = await newProfile();
  const other = await newProfile();
  const lead = await leadFor(p.id);
  await saveLeadToCrm(p, lead.id, true);

  assert.equal((await changeLeadStatus(p, lead.id, "shipped")).ok, false, "unknown status");
  assert.equal((await changeLeadStatus(p, lead.id, "researching")).ok, true);
  assert.equal((await changeLeadStatus(other, lead.id, "lost")).ok, false, "not their lead");
  assert.equal((await addNote(other, lead.id, "hi")).ok, false);
  assert.equal((await addNote(p, lead.id, "  ")).ok, false, "empty note");

  await addNote(p, lead.id, "Uses a spreadsheet today");
  const note = (await getCrmLead(p.id, lead.id))!.notes[0];
  assert.equal((await editNote(other, note.id, "x")).ok, false);
  assert.equal((await editNote(p, note.id, "Uses a spreadsheet; budget unclear")).ok, true);
  assert.equal((await removeNote(other, note.id)).ok, false);

  assert.equal((await scheduleFollowUp(p, lead.id, { date: "not a date" })).ok, false);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await scheduleFollowUp(p, lead.id, { date: today, note: "Check in" })).ok, true);
  assert.equal((await getFollowUps(p.id)).length, 1);
  assert.equal((await getCrmMetrics(p.id)).followUpsDue, 1);
  assert.equal((await finishFollowUp(p, lead.id)).ok, true);
  assert.equal((await getFollowUps(p.id)).length, 0);

  // Logged by the user, moves the pipeline forward but never back
  await logInteraction(p, lead.id, "contact");
  assert.equal((await getCrmLead(p.id, lead.id))!.lead.status, "contacted");
  await changeLeadStatus(p, lead.id, "qualified");
  await logInteraction(p, lead.id, "response");
  const detail = (await getCrmLead(p.id, lead.id))!;
  assert.equal(detail.lead.status, "qualified", "not moved back to replied");
  assert.ok(detail.activities.filter((a) => a.kind === "contact_logged").every((a) => a.userEntered));
  assert.equal(await getCrmLead(other.id, lead.id), null);

  const metrics = await getCrmMetrics(p.id);
  assert.deepEqual(
    { saved: metrics.saved, contacted: metrics.contacted, qualified: metrics.qualified, done: metrics.followUpsCompleted },
    { saved: 1, contacted: 1, qualified: 1, done: 1 },
  );

  assert.equal((await removeLead(other, lead.id)).ok, false);
  assert.equal((await removeLead(p, lead.id)).ok, true);
  assert.equal(await getCrmLead(p.id, lead.id), null);
});

test("search and sorting stay within the user's saved leads", async () => {
  const p = await newProfile();
  const a = await leadFor(p.id, `alpha${randomUUID().slice(0, 6)}`);
  const b = await leadFor(p.id, `beta${randomUUID().slice(0, 6)}`);
  await saveLeadToCrm(p, a.id, true);
  await saveLeadToCrm(p, b.id, true);
  assert.deepEqual((await getCrmLeads(p.id, { q: a.authorHandle })).map((l) => l.id), [a.id]);
  assert.equal((await getCrmLeads(p.id, { q: "%" })).length, 0, "wildcards are literal");
  assert.equal((await getCrmLeads(p.id, { sort: "follow_up" })).length, 2);
});

test("rescans: a new signal from someone in the CRM joins their lead; CRM data is kept", async () => {
  const p = await newProfile();
  await saveIcp(p, {
    product: "An AI tool that helps SaaS founders find their first customers on X.",
    audience: "SaaS founders",
    problems: ["finding first customers"],
    industries: [],
    buyingSignals: [],
    excluded: [],
  });
  const author = `c${Date.now()}`;
  addTweets(author, 1);
  await watch(p.id, [author]);
  await runScout(p.id);
  const [lead] = await getLeads(p.id, {});
  const profile = await getProfile(p.id);
  await saveLeadToCrm(profile, lead.id, true);
  await changeLeadStatus(profile, lead.id, "contacted");
  await addNote(profile, lead.id, "Keep this");

  addTweets(author, 1);
  await ageRuns(p.id);
  // The shared cache is no longer fresh, so the new post is fetched
  await db.update(s.xAccountsTable).set({ lastFetchedAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(s.xAccountsTable.platformUserId, author));
  await runScout(p.id);
  assert.equal((await getLeads(p.id, {})).length, 1, "no second lead for the same person");
  const detail = (await getCrmLead(p.id, lead.id))!;
  assert.ok(detail.activities.some((a) => a.kind === "new_signal"), "the new post is on their timeline");
  assert.equal(detail.lead.status, "contacted", "status untouched");
  assert.equal(detail.notes[0].body, "Keep this");
});
