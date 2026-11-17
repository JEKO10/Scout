import "server-only";

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { countAiCallsSince } from "@/db/queries/aiUsage";
import {
  getTrend,
  getTrendPosts,
  lockTrendInsight,
  saveTrendInsight,
  unlockTrendInsight,
} from "@/db/queries/trends";
import type { Profile, Trend } from "@/db/schema";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import { effectiveLimits } from "@/lib/billing/plans";
import type { TrendInsight } from "@/lib/trends/types";
import { recordAiUsage } from "@/services/ai/usage";
import { track } from "@/services/analytics/track";
import { getUsageBudget } from "@/services/billing/budget";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

/** A conservative estimate per insight, to keep generation inside the scoring budget */
export const INSIGHT_USD = 0.02;
const MAX_POSTS = 8;

// Plain strings for the AI's JSON schema; lengths are capped after parsing
const text = (max: number) => z.string().describe(`At most ${max} characters`);
const clip = (value: string, max: number) => value.trim().slice(0, max);

const insightSchema = z.object({
  summary: text(240).describe("1-2 sentences: what this trend is, from the posts"),
  discussion: text(500).describe("What people in these posts are discussing"),
  drivers: text(400).describe('What seems to drive it, only if the posts show it; otherwise exactly "Not clear from these posts."'),
  recurringQuestions: z.array(text(160)).describe("0-4 questions or problems that recur in the posts"),
  sentiment: z.enum(["positive", "negative", "mixed", "neutral"]),
  whyItMatters: text(400).describe("Why it matters to this user specifically, from their profile"),
  angles: z.object({
    educational: text(240),
    personal: text(240).describe("Grounded in what the user's profile says they do or know; never invent experiences"),
    practical: text(240),
    contrarian: text(240).nullable().describe("Only when a contrarian view is genuinely justified by the posts; otherwise null"),
  }),
  hooks: z.array(text(140)).describe("2-3 short opening lines in the user's voice"),
  format: z.object({
    type: z.enum(["short_post", "thread", "reply", "question"]),
    why: text(240),
  }),
  recommendedAction: text(300).describe("One concrete next step for this user"),
  supportingPostIds: z.array(z.string()).describe("IDs of the posts this explanation relies on"),
});

const INSTRUCTIONS = `You explain a topic trending in one user's niche on X, and suggest how they could take part.
Use ONLY the posts given. Never invent news, launches, numbers, causes or quotes that the posts don't contain; if the cause isn't visible, say "Not clear from these posts."
These posts are a sample Scout collected for this user, not all of X; don't generalize beyond them.
Personalize from the user's profile: their work, expertise, audience and (if given) what they sell. Content ideas must be things this specific person could credibly say; never invent personal experiences.
Hooks: short, natural, no hashtags, no clickbait. Suggest a contrarian angle only when the posts justify one; otherwise null.
supportingPostIds: the IDs of the posts you relied on.`;

export type InsightResult =
  | { ok: true; insight: TrendInsight; cached: boolean }
  | { ok: false; message: string };

/** The evidence changed enough (≥30% more or fewer posts, or ≥2 different representative posts) to rewrite */
export function insightIsStale(trend: Pick<Trend, "insight" | "insightBasis" | "postCount" | "representativeCandidateIds">): boolean {
  if (!trend.insight || !trend.insightBasis) return true;
  const { postCount, candidateIds } = trend.insightBasis;
  const changed = trend.representativeCandidateIds.filter((id) => !candidateIds.includes(id)).length;
  return Math.abs(trend.postCount - postCount) / Math.max(1, postCount) >= 0.3 || changed >= 2;
}

/**
 * Day 30: the AI explanation and content ideas for one trend, on request.
 * Cached on the trend and reused until its evidence changes meaningfully;
 * one generation at a time; capped per day and paid from the scoring budget.
 */
export async function generateTrendInsight(profile: Profile, trendId: string): Promise<InsightResult> {
  const trend = await getTrend(profile.id, trendId);
  if (!trend) return { ok: false, message: "Trend not found." };
  if (trend.insight && !insightIsStale(trend)) return { ok: true, insight: trend.insight, cached: true };

  const cap = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxTrendInsightsPerDay;
  if ((await countAiCallsSince(profile.id, "trend_insight", new Date(Date.now() - 24 * 60 * 60_000))) >= cap) {
    return { ok: false, message: `Your plan includes ${cap} trend insights a day. More tomorrow.` };
  }
  if ((await getUsageBudget(profile)).remaining.scoringUsd < INSIGHT_USD) {
    return { ok: false, message: "Today's AI budget is used up. More becomes available tomorrow." };
  }
  if (!(await lockTrendInsight(profile.id, trend.id, 90))) {
    return { ok: false, message: "This insight is already being written. Refresh in a moment." };
  }

  try {
    const posts = (await getTrendPosts(profile.id, trend.representativeCandidateIds)).slice(0, MAX_POSTS);
    if (posts.length < 2) {
      await unlockTrendInsight(profile.id, trend.id);
      return { ok: false, message: "Not enough posts are stored for this trend to explain it reliably." };
    }
    const brain = resolveScoutBrain(profile);
    const input = {
      user: {
        occupation: profile.occupation,
        knownFor: brain?.goals.knownFor.map((item) => item.label) ?? profile.knownFor,
        audience: brain?.goals.targetAudience.map((item) => item.label) ?? profile.targetAudience,
        topics: brain?.interests.topics.map((item) => item.label).slice(0, 10) ?? profile.topics,
        offers: profile.leadProfile?.product ?? null,
        voice: brain?.voice.summary ?? profile.voiceDescription,
      },
      trend: {
        label: trend.label,
        oftenMentioned: trend.terms,
        status: trend.status,
        postsObserved: trend.postCount,
        accounts: trend.authorCount,
      },
      posts: posts.map(({ candidate }) => ({
        id: candidate.id,
        author: `@${candidate.authorHandle}`,
        postedAt: candidate.postedAt.toISOString(),
        replies: candidate.metrics?.replies ?? 0,
        likes: candidate.metrics?.likes ?? 0,
        text: candidate.content,
      })),
    };

    const response = await getOpenAI().responses.parse({
      model: AI_MODELS.scoring,
      instructions: INSTRUCTIONS,
      input: JSON.stringify(input),
      reasoning: { effort: "low" },
      text: { format: zodTextFormat(insightSchema, "trend_insight") },
    });
    await recordAiUsage({ profileId: profile.id, operation: "trend_insight" }, response);
    const parsed = insightSchema.safeParse(response.output_parsed);
    if (!parsed.success) {
      await unlockTrendInsight(profile.id, trend.id);
      return { ok: false, message: "Couldn't write an insight this time. Try again later." };
    }

    const known = new Set(posts.map(({ candidate }) => candidate.id));
    const d = parsed.data;
    const insight: TrendInsight = {
      summary: clip(d.summary, 240),
      discussion: clip(d.discussion, 500),
      drivers: clip(d.drivers, 400),
      sentiment: d.sentiment,
      whyItMatters: clip(d.whyItMatters, 400),
      angles: {
        educational: clip(d.angles.educational, 240),
        personal: clip(d.angles.personal, 240),
        practical: clip(d.angles.practical, 240),
        contrarian: d.angles.contrarian ? clip(d.angles.contrarian, 240) : null,
      },
      format: { type: d.format.type, why: clip(d.format.why, 240) },
      recommendedAction: clip(d.recommendedAction, 300),
      recurringQuestions: d.recurringQuestions.slice(0, 4).map((q) => clip(q, 160)),
      hooks: d.hooks.slice(0, 3).map((hook) => clip(hook, 140)),
      // Only posts that were really given: the evidence links can't point elsewhere
      supportingCandidateIds: d.supportingPostIds.filter((id) => known.has(id)),
    };
    await saveTrendInsight(profile.id, trend.id, insight, {
      postCount: trend.postCount,
      candidateIds: trend.representativeCandidateIds,
    });
    await track("trend_insight_generated", { profileId: profile.id });
    return { ok: true, insight, cached: false };
  } catch (error) {
    await unlockTrendInsight(profile.id, trend.id);
    throw error;
  }
}
