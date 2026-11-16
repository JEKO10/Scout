import "server-only";

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { countAiCallsSince } from "@/db/queries/aiUsage";
import type { Profile } from "@/db/schema";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import { cleanKeywords, MAX_EXCLUDED, MAX_KEYWORDS } from "@/lib/discovery/query";
import { recordAiUsage } from "@/services/ai/usage";
import { getUsageBudget } from "@/services/billing/budget";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

/** Suggestions are small calls, but still capped per user and day */
export const MAX_SUGGESTIONS_PER_DAY = 10;

const suggestionSchema = z.object({
  keywords: z.array(z.string()).describe("3 to 8 short search terms or phrases people would actually write"),
  excludedKeywords: z.array(z.string()).describe("0 to 5 terms that would bring irrelevant posts (jobs, giveaways, unrelated meanings)"),
});

const INSTRUCTIONS = `You help a user of Scout find conversations on X worth joining.
From a topic they describe and a short profile, suggest search terms for X's search.
Rules:
- Terms are plain words or short phrases (1-4 words) that real people write in posts about this topic, not hashtags unless they're common.
- Prefer terms that find people asking, struggling or discussing (where a reply can help), not news or ads.
- Excluded terms remove obvious noise: hiring posts, giveaways, crypto shilling, unrelated meanings of a keyword.
- No search operators, quotes, or punctuation besides apostrophes and hyphens.`;

export type KeywordSuggestion = { ok: true; keywords: string[]; excludedKeywords: string[] } | { ok: false; message: string };

/**
 * AI-suggested search terms for a topic, from its description and the user's
 * Scout Brain. Suggestions only: the user reviews and edits them before
 * saving, and nothing is searched until their next scan.
 */
export async function suggestKeywords(
  profile: Profile,
  topic: { name: string; description: string },
): Promise<KeywordSuggestion> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  if ((await countAiCallsSince(profile.id, "discovery_keywords", since)) >= MAX_SUGGESTIONS_PER_DAY) {
    return { ok: false, message: "You've used today's keyword suggestions. Add keywords by hand, or try again tomorrow." };
  }
  // Same allowance as scoring: no AI work beyond the plan's budget
  if ((await getUsageBudget(profile)).monthRemaining.scoringUsd <= 0) {
    return { ok: false, message: "Your monthly AI budget is used up. Add keywords by hand for now." };
  }

  const brain = resolveScoutBrain(profile);
  const context = {
    topic,
    profile: {
      occupation: profile.occupation,
      topics: brain?.interests.topics.map((item) => item.label).slice(0, 10) ?? profile.topics,
      audience: brain?.goals.targetAudience.map((item) => item.label).slice(0, 5) ?? profile.targetAudience,
      languages: brain?.voice.languages,
    },
  };

  const response = await getOpenAI().responses.parse({
    model: AI_MODELS.scoring,
    instructions: INSTRUCTIONS,
    input: JSON.stringify(context),
    reasoning: { effort: "low" },
    text: { format: zodTextFormat(suggestionSchema, "discovery_keywords") },
  });
  await recordAiUsage({ profileId: profile.id, operation: "discovery_keywords" }, response);
  const parsed = response.output_parsed;
  if (!parsed) return { ok: false, message: "Couldn't suggest keywords. Add them by hand." };
  return {
    ok: true,
    keywords: cleanKeywords(parsed.keywords, MAX_KEYWORDS),
    excludedKeywords: cleanKeywords(parsed.excludedKeywords, MAX_EXCLUDED),
  };
}
