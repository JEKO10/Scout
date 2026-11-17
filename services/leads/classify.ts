import "server-only";

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { addLeadActivity, findSavedLeadByAuthor } from "@/db/queries/crm";
import { getLeadCandidates, insertLeads, markCandidatesLeadChecked, type NewLead } from "@/db/queries/leads";
import type { Profile, ScoutCandidate } from "@/db/schema";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import { effectiveLimits } from "@/lib/billing/plans";
import { type LeadProfile, leadScore, recencyPoints } from "@/lib/leads/types";
import { recordAiUsage } from "@/services/ai/usage";
import { getUsageBudget } from "@/services/billing/budget";
import { MAX_POST_AGE_DAYS } from "@/services/scout/filters";

/** Only posts the opportunity scoring found at least this relevant are checked */
export const LEAD_MIN_RELEVANCE = 40;
/** A conservative per-post estimate, to keep checks within the scoring budget */
export const LEAD_CHECK_USD = 0.006;

const judgmentSchema = z.object({
  judgments: z.array(
    z.object({
      candidateId: z.string(),
      intent: z.enum(["high", "medium", "low", "not_a_lead"]),
      icpFit: z.number().describe("0-30: how well the author fits the ideal customer, from the post only"),
      intentStrength: z.number().describe("0-35: how clearly they signal a need or are looking for a solution"),
      problemFit: z.number().describe("0-20: how closely their problem matches what the product solves"),
      evidence: z.number().describe("0-10: how explicit the post is; 0 if you'd be guessing"),
      evidenceQuote: z.string().describe("Exact words copied from the post that show the need; empty for not_a_lead"),
      reason: z.string().describe("One sentence: why this is (or isn't) a lead"),
      suggestedAction: z.string().describe("One sentence: how the user could help in a reply"),
    }),
  ),
});

const INSTRUCTIONS = `You check public X posts for buying intent for one user's product or service, given their ideal customer profile.
Judge each post only from its own words. Never infer private or sensitive traits (health, finances, politics, religion, identity) and never assume intent the post doesn't show.
Intent:
- high: explicitly asks for a tool/service/recommendation, wants alternatives to software they use, or states an immediate need the product meets.
- medium: describes a problem the product solves, complains about their current solution, or is exploring approaches.
- low: general discussion or educational questions in the space, without a clear need.
- not_a_lead: unrelated, spam, promotional (selling their own thing), job ads unrelated to the product, or not enough evidence.
evidenceQuote must be copied exactly from the post. suggestedAction: genuinely helpful first, mention the product only if it truly fits; never a hard sell, never a DM script.
Return one judgment per post, with its candidateId.`;

export type LeadCheckStats = { checked: number; leads: number; high: number; skippedReason?: string };

/**
 * Day 27 Lead Scout, after a scan's opportunity scoring: the most relevant
 * new candidates (from the watchlist and Smart Discovery alike) are checked
 * for buying intent in one AI call. Each post is checked once, ever; checks
 * are paid from the scoring budget and capped per scan by the plan.
 */
export async function classifyLeads(profile: Profile, scoutRunId: string): Promise<LeadCheckStats> {
  const icp = profile.leadProfile;
  if (!icp) return { checked: 0, leads: 0, high: 0, skippedReason: "No customer profile yet" };

  const budget = await getUsageBudget(profile);
  const affordable = Math.floor(budget.remaining.scoringUsd / LEAD_CHECK_USD);
  const cap = Math.min(effectiveLimits(profile.plan, profile.usageLimitOverrides).maxLeadChecksPerRun, affordable);
  if (cap <= 0) return { checked: 0, leads: 0, high: 0, skippedReason: "No scoring budget left today" };

  const candidates = await getLeadCandidates(profile.id, {
    minScore: LEAD_MIN_RELEVANCE,
    postedAfter: new Date(Date.now() - MAX_POST_AGE_DAYS * 86_400_000),
    limit: cap,
  });
  if (candidates.length === 0) return { checked: 0, leads: 0, high: 0 };

  const response = await getOpenAI().responses.parse({
    model: AI_MODELS.scoring,
    instructions: INSTRUCTIONS,
    input: buildInput(icp, candidates),
    reasoning: { effort: "low" },
    text: { format: zodTextFormat(judgmentSchema, "lead_judgments") },
  });
  await recordAiUsage({ profileId: profile.id, operation: "lead_classification", scoutRunId }, response);
  const judgments = response.output_parsed?.judgments ?? [];

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const checked: string[] = [];
  const leads: NewLead[] = [];
  const now = new Date();
  for (const judgment of judgments) {
    const candidate = byId.get(judgment.candidateId);
    if (!candidate || checked.includes(candidate.id)) continue;
    checked.push(candidate.id);
    const lead = toLead(profile.id, candidate, judgment, now);
    if (!lead) continue;
    // Day 28: a new signal from someone already in the CRM joins their lead;
    // their status, notes and follow-ups are never touched by a scan
    const existing = lead.authorPlatformUserId ? await findSavedLeadByAuthor(profile.id, lead.authorPlatformUserId) : undefined;
    if (existing) {
      await addLeadActivity(profile.id, existing.id, "new_signal", {
        detail: { postUrl: lead.postUrl, evidence: lead.evidence, intent: lead.intent, score: lead.score },
      });
      continue;
    }
    leads.push(lead);
  }
  // Checked once, lead or not; posts the model skipped are checked next scan
  await markCandidatesLeadChecked(profile.id, checked);
  await insertLeads(leads);
  return { checked: checked.length, leads: leads.length, high: leads.filter((lead) => lead.intent === "high").length };
}

function buildInput(icp: LeadProfile, candidates: ScoutCandidate[]): string {
  return JSON.stringify({
    idealCustomerProfile: icp,
    posts: candidates.map((candidate) => ({
      candidateId: candidate.id,
      author: `@${candidate.authorHandle}`,
      postedAt: candidate.postedAt.toISOString(),
      text: candidate.content,
    })),
  });
}

/**
 * A lead only with evidence the post actually contains: the quote must be in
 * the post, word for word. Anything else (or "not a lead") stores nothing.
 */
export function toLead(
  profileId: string,
  candidate: ScoutCandidate,
  judgment: z.infer<typeof judgmentSchema>["judgments"][number],
  now = new Date(),
): NewLead | null {
  if (judgment.intent === "not_a_lead") return null;
  const quote = judgment.evidenceQuote.trim();
  if (quote.length < 4 || !candidate.content.toLowerCase().includes(quote.toLowerCase())) return null;
  const breakdown = {
    icpFit: judgment.icpFit,
    intentStrength: judgment.intentStrength,
    problemFit: judgment.problemFit,
    evidence: judgment.evidence,
    recency: recencyPoints(candidate.postedAt, now),
  };
  return {
    profileId,
    candidateId: candidate.id,
    discoveryTopicId: candidate.discoveryTopicId,
    platform: candidate.platform,
    platformPostId: candidate.platformPostId,
    authorPlatformUserId: candidate.authorPlatformUserId,
    authorHandle: candidate.authorHandle,
    postUrl: candidate.url,
    content: candidate.content,
    postedAt: candidate.postedAt,
    intent: judgment.intent,
    score: leadScore(breakdown),
    scoreBreakdown: breakdown,
    evidence: quote,
    reason: judgment.reason.trim(),
    suggestedAction: judgment.suggestedAction.trim(),
  };
}
