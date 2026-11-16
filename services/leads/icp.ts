import "server-only";

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { countAiCallsSince } from "@/db/queries/aiUsage";
import { saveLeadProfile } from "@/db/queries/leads";
import type { Profile } from "@/db/schema";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import type { LeadProfile } from "@/lib/leads/types";
import { recordAiUsage } from "@/services/ai/usage";
import { getUsageBudget } from "@/services/billing/budget";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

export const MAX_ICP_SUGGESTIONS_PER_DAY = 5;

const list = (max: number) =>
  z
    .array(z.string().trim().min(1).max(120))
    .max(max)
    .transform((items) => [...new Set(items)]);

export const leadProfileSchema = z.object({
  product: z.string().trim().min(10, "Describe your product or service in a sentence.").max(500),
  audience: z.string().trim().min(3, "Who is it for?").max(300),
  problems: list(8).refine((items) => items.length > 0, "Add at least one problem it solves."),
  industries: list(8),
  buyingSignals: list(8),
  excluded: list(10),
});

export type LeadProfileInput = z.input<typeof leadProfileSchema>;

export async function saveIcp(profile: Profile, input: LeadProfileInput): Promise<{ ok: boolean; message: string }> {
  const parsed = leadProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check your customer profile." };
  await saveLeadProfile(profile.id, parsed.data);
  return { ok: true, message: "Saved. Scout checks relevant posts for buying intent in your next scans." };
}

const suggestionSchema = z.object({
  product: z.string(),
  audience: z.string(),
  problems: z.array(z.string()),
  industries: z.array(z.string()),
  buyingSignals: z.array(z.string()),
  excluded: z.array(z.string()),
});

const INSTRUCTIONS = `Draft an ideal customer profile for a person's product or service, from their Scout profile.
Use only what the profile supports. If they don't clearly sell something, describe what they seem to offer (e.g. their services or expertise) and keep it modest. Never invent features, prices or customers.
- product: one or two sentences.
- audience: who buys it, in one line.
- problems: 2-5 problems it solves, as the customer would say them.
- industries: 0-4 niches.
- buyingSignals: 2-5 things a person would post when they need it ("looking for…", "any recommendations for…").
- excluded: 0-4 audiences or keywords to ignore (competitors' promos, job posts, students).`;

/** A first draft from the Scout Brain; the user reviews and edits it before saving */
export async function suggestIcp(profile: Profile): Promise<{ ok: true; icp: LeadProfile } | { ok: false; message: string }> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  if ((await countAiCallsSince(profile.id, "lead_icp", since)) >= MAX_ICP_SUGGESTIONS_PER_DAY) {
    return { ok: false, message: "You've used today's suggestions. Edit the profile by hand, or try again tomorrow." };
  }
  if ((await getUsageBudget(profile)).monthRemaining.scoringUsd <= 0) {
    return { ok: false, message: "Your monthly AI budget is used up. Fill the profile in by hand for now." };
  }
  const brain = resolveScoutBrain(profile);
  const context = {
    occupation: profile.occupation,
    bio: profile.bio,
    primaryGoal: profile.primaryGoal,
    targetAudience: brain?.goals.targetAudience.map((item) => item.label) ?? profile.targetAudience,
    knownFor: brain?.goals.knownFor.map((item) => item.label) ?? profile.knownFor,
    topics: brain?.interests.topics.map((item) => item.label).slice(0, 10) ?? profile.topics,
  };
  const response = await getOpenAI().responses.parse({
    model: AI_MODELS.scoring,
    instructions: INSTRUCTIONS,
    input: JSON.stringify(context),
    reasoning: { effort: "low" },
    text: { format: zodTextFormat(suggestionSchema, "lead_profile") },
  });
  await recordAiUsage({ profileId: profile.id, operation: "lead_icp" }, response);
  const parsed = leadProfileSchema.safeParse(response.output_parsed);
  if (!parsed.success) return { ok: false, message: "Couldn't draft a profile. Fill it in by hand." };
  return { ok: true, icp: parsed.data };
}
