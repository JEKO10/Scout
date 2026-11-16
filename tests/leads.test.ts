// Day 27 Lead Scout: customer profile, buying-intent checks after scoring,
// transparent scores with real evidence, each post checked once, budgets and
// plan caps, user isolation, and lead-aware replies. X and OpenAI are mocked;
// the database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { ensureLeadOpportunity, getLead, getLeads, setLeadSaved } from "@/db/queries/leads";
import * as s from "@/db/schema";
import { leadScore, recencyPoints } from "@/lib/leads/types";
import { classifyLeads, toLead } from "@/services/leads/classify";
import { saveIcp, suggestIcp } from "@/services/leads/icp";
import { generateReplies } from "@/services/replies/generateReply";
import { runScout } from "@/services/scout/runScout";

import { ageRuns, cleanup, getProfile, newProfile, rememberXUsage, watch } from "./helpers/db";
import { addTweets, ai, installMocks } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(async () => {
  ai.leadIntent = "high";
  ai.leadQuote = undefined;
  await cleanup();
});

const icp = {
  product: "An AI tool that helps SaaS founders find their first customers on X.",
  audience: "Early-stage SaaS founders",
  problems: ["finding first customers"],
  industries: ["SaaS"],
  buyingSignals: ["asking for customer acquisition advice"],
  excluded: ["job posts"],
};

let seq = 0;
const xUser = () => `l${Date.now()}${seq++}`;
const leadCalls = () => ai.calls.filter((call) => call === "lead_judgments").length;

async function withLeads(overrides = {}) {
  const p = await newProfile(overrides);
  await saveIcp(p, icp);
  const user = xUser();
  addTweets(user, 4);
  await watch(p.id, [user]);
  return getProfile(p.id);
}

test("scores: transparent parts, capped, and recency computed", () => {
  assert.equal(leadScore({ icpFit: 30, intentStrength: 35, problemFit: 20, evidence: 10, recency: 5 }), 100);
  assert.equal(leadScore({ icpFit: 99, intentStrength: -4, problemFit: 20, evidence: 10, recency: 5 }), 65, "each part clamped");
  const now = new Date();
  assert.equal(recencyPoints(new Date(now.getTime() - 3600_000), now), 5);
  assert.equal(recencyPoints(new Date(now.getTime() - 8 * 86_400_000), now), 0);
});

test("evidence: a lead needs words the post actually contains", () => {
  const candidate = {
    id: "c1",
    content: "Any recommendations for an affordable SEO tool? Our traffic is flat.",
    postedAt: new Date(),
  } as s.ScoutCandidate;
  const judgment = {
    candidateId: "c1",
    intent: "high" as const,
    icpFit: 25,
    intentStrength: 33,
    problemFit: 18,
    evidence: 9,
    evidenceQuote: "recommendations for an affordable SEO tool",
    reason: "Asking for an SEO tool.",
    suggestedAction: "Share how you'd choose one.",
  };
  const lead = toLead("p", candidate, judgment);
  assert.equal(lead?.intent, "high");
  assert.equal(lead?.score, 25 + 33 + 18 + 9 + 5);
  assert.equal(toLead("p", candidate, { ...judgment, evidenceQuote: "they want to buy now" }), null, "invented evidence");
  assert.equal(toLead("p", candidate, { ...judgment, intent: "not_a_lead" }), null);
});

test("customer profile: validated, drafted from the Brain for review", async () => {
  const p = await newProfile();
  assert.equal((await saveIcp(p, { ...icp, problems: [] })).ok, false, "a problem is required");
  assert.equal((await saveIcp(p, { ...icp, product: "x" })).ok, false);
  const draft = await suggestIcp(p);
  assert.ok(draft.ok && draft.icp.problems.length === 2, "drafted, duplicates removed");
  assert.equal((await getProfile(p.id)).leadProfile, null, "a draft isn't saved");
});

test("scan: relevant posts are checked once for intent and stored as leads with evidence", async () => {
  const p = await withLeads({ maxLeadChecksPerRun: 3 });
  const before = leadCalls();
  const result = await runScout(p.id);
  assert.equal(result.status, "completed");
  assert.equal(leadCalls() - before, 1, "one batched AI call");
  if (result.status === "completed") assert.equal(result.stats.leads?.checked, 3, "capped by the plan");

  const leads = await getLeads(p.id, {});
  assert.equal(leads.length, 3);
  for (const lead of leads) {
    assert.equal(lead.intent, "high");
    assert.ok(lead.content.toLowerCase().includes(lead.evidence.toLowerCase()));
    assert.ok(lead.score > 0 && lead.score <= 100);
  }

  // The remaining candidate is checked next scan; the three never again
  await ageRuns(p.id);
  await runScout(p.id);
  assert.equal((await getLeads(p.id, {})).length, 4);
  await ageRuns(p.id);
  const calls = leadCalls();
  await runScout(p.id);
  assert.equal(leadCalls(), calls, "nothing new: no AI call");
});

test("no profile, no budget or no intent: nothing stored", async () => {
  const noIcp = await newProfile();
  const user = xUser();
  addTweets(user, 2);
  await watch(noIcp.id, [user]);
  await runScout(noIcp.id);
  assert.equal((await getLeads(noIcp.id, {})).length, 0);

  const broke = await withLeads({ monthlyScoringUsd: 0.001 });
  assert.equal((await classifyLeads(broke, "00000000-0000-0000-0000-000000000000")).checked, 0);

  ai.leadIntent = "not_a_lead";
  const none = await withLeads();
  await runScout(none.id);
  assert.equal((await getLeads(none.id, {})).length, 0);
  const checked = await db.select().from(s.scoutCandidatesTable).where(eq(s.scoutCandidatesTable.profileId, none.id));
  assert.ok(checked.some((row) => row.leadCheckedAt), "checked even when not a lead");
  ai.leadIntent = "high";
});

test("isolation, saving and lead-aware replies", async () => {
  const p = await withLeads({ maxLeadChecksPerRun: 1 });
  const other = await newProfile();
  await runScout(p.id);
  const [lead] = await getLeads(p.id, {});

  assert.equal(await getLead(other.id, lead.id), undefined, "another user can't read it");
  assert.equal(await setLeadSaved(other.id, lead.id, true), false, "or change it");
  assert.equal(await setLeadSaved(p.id, lead.id, true), true);
  assert.equal((await getLeads(p.id, { saved: true })).length, 1);

  const opportunityId = await ensureLeadOpportunity(p.id, lead);
  assert.ok(opportunityId);
  assert.equal(await ensureLeadOpportunity(p.id, (await getLead(p.id, lead.id))!), opportunityId, "same one again");

  const result = await generateReplies(p.id, opportunityId!, { styles: ["natural", "stronger_take"] });
  assert.equal(result.status, "generated");
  const input = String(ai.requests.at(-1)?.input ?? "");
  assert.match(input, /Possible customer \(Lead Scout\)/);
  assert.match(input, /No sales pitch/);
});
