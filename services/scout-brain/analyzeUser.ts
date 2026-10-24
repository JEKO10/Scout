import "server-only";

import { zodTextFormat } from "openai/helpers/zod";

import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getProfileById, updateProfileBrain } from "@/db/queries/profiles";
import { getOpenAI, OPENAI_MODEL } from "@/lib/ai/client";
import {
  type ScoutBrainAnalysis,
  scoutBrainAnalysisSchema,
} from "@/lib/ai/schemas/scoutBrain";

import { splitHoldout } from "./holdout";
import { measureVoice, phraseFrequency } from "./measureVoice";
import {
  buildScoutBrainInput,
  hasTextBeyondLinks,
  SCOUT_BRAIN_INSTRUCTIONS,
} from "./prompt";

const ANALYSIS_POST_LIMIT = 100;
export const MIN_POSTS_FOR_ANALYSIS = 5;

export type AnalyzeUserResult =
  | { status: "not_enough_posts"; postCount: number }
  | { status: "analyzed"; postCount: number; holdoutCount: number };

/**
 * profile + recent X posts → OpenAI structured output → Zod → profile brains.
 * Re-running replaces the AI analysis but keeps the user's edits.
 */
export async function analyzeUser(
  profileId: string,
): Promise<AnalyzeUserResult> {
  const [profile, recentPosts] = await Promise.all([
    getProfileById(profileId),
    getRecentPostsForProfile(profileId, ANALYSIS_POST_LIMIT),
  ]);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const { training, holdout } = splitHoldout(
    recentPosts.filter((post) => hasTextBeyondLinks(post.content)),
  );

  if (training.length < MIN_POSTS_FOR_ANALYSIS) {
    return { status: "not_enough_posts", postCount: training.length };
  }

  // Holdout posts never reach the model; evals compare against them later
  const response = await getOpenAI().responses.parse({
    model: OPENAI_MODEL,
    instructions: SCOUT_BRAIN_INSTRUCTIONS,
    input: buildScoutBrainInput(profile, training),
    text: { format: zodTextFormat(scoutBrainAnalysisSchema, "scout_brain") },
  });

  // zodTextFormat already validated the JSON against the schema
  const analysis = response.output_parsed;
  if (!analysis) {
    throw new Error("OpenAI returned no structured Scout Brain output.");
  }

  // The model picks the phrases; code counts how often they're really used
  analysis.voice.signaturePhrases = analysis.voice.signaturePhrases.map(
    ({ phrase }) => ({ phrase, frequency: phraseFrequency(phrase, training) }),
  );

  const knownPostIds = new Set(training.map((post) => post.platformPostId));
  await updateProfileBrain(profileId, {
    analysis: dropUnknownPostIds(analysis, knownPostIds),
    measured: measureVoice(training),
    postCount: training.length,
    holdoutPostIds: holdout.map((post) => post.platformPostId),
    model: response.model,
  });

  return {
    status: "analyzed",
    postCount: training.length,
    holdoutCount: holdout.length,
  };
}

/** The model can hallucinate IDs; keep only ones that were actually sent. */
function dropUnknownPostIds(
  analysis: ScoutBrainAnalysis,
  known: Set<string>,
): ScoutBrainAnalysis {
  const keep = (ids: string[]) => ids.filter((id) => known.has(id)).slice(0, 5);

  return {
    ...analysis,
    voice: {
      ...analysis.voice,
      examplePostIds: keep(analysis.voice.examplePostIds),
    },
    interests: {
      ...analysis.interests,
      topics: analysis.interests.topics.map((topic) => ({
        ...topic,
        examplePostIds: keep(topic.examplePostIds),
      })),
      opinions: analysis.interests.opinions.map((opinion) => ({
        ...opinion,
        examplePostIds: keep(opinion.examplePostIds),
      })),
    },
  };
}
