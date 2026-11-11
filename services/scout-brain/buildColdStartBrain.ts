import "server-only";

import { zodTextFormat } from "openai/helpers/zod";

import { getProfileById, updateProfileBrain } from "@/db/queries/profiles";
import { getPostedReplies } from "@/db/queries/replies";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import type { Profile, VoiceSample } from "@/db/schema";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import { scoutBrainAnalysisSchema } from "@/lib/ai/schemas/scoutBrain";
import { recordAiUsage } from "@/services/ai/usage";

import { measureVoice, phraseFrequency } from "./measureVoice";

/** Recent posted replies sent along: enough voice evidence, bounded prompt */
const MAX_POSTED_REPLIES = 20;

const INSTRUCTIONS = `You are building a "Scout Brain" for a person who has little or no posting history on X. Scout uses it to find conversations they should join and to write replies that sound like them.

You get their onboarding answers and, when available, writing of their own: replies they wrote to sample posts during calibration, opinions they wrote down to teach Scout, and replies they actually posted through Scout (the final text, after their own edits). Produce the same three parts as always: voice, interests, goals.

Separate what is declared from what is observed, and never invent:
- "stated": the user said it in onboarding (topics, expertise, goals, how they want to sound).
- "observed": visible in their own writing: calibration replies and posted replies (wording, stance, length, tone).
- "inferred": avoid. If you must, keep confidence low.
- Never invent past opinions, experiences, achievements, products or expertise. Opinions come only from their own writing: stances in their replies (observed) and opinions they wrote down (stated).
- Keep distinct takes as separate opinions; never merge several into one. Many opinions with their own wording beat one general one.
- When there isn't enough data for a field, say so plainly (e.g. humor: "Unknown: not enough writing samples yet").

Voice:
- Base voice on their writing when present (observed), posted replies first: those are what they actually sent. Otherwise use their description of how they want to sound (stated), with low confidence.
- signaturePhrases only if a phrase actually appears in their replies; otherwise empty.
- examplePostIds must be empty: there are no posts.

Interests:
- topics: the topics they declared (evidence "stated", postCount 0). Mark a topic "observed" only if their replies show real depth on it.
- Topics they want to avoid go in lowConfidenceTopics with the reason "The user doesn't want to comment on this."

Goals come straight from their answers. Be honest in postingAlignment that there is no posting history yet.

Write all descriptions in English.`;

type PostedReply = { post: string; reply: string; authorHandle: string | null };

function buildInput(
  profile: Profile,
  samples: VoiceSample[],
  posted: PostedReply[],
): string {
  const calibration = samples.filter((sample) => sample.source === "onboarding");
  const opinions = samples.filter((sample) => sample.source === "opinion");
  const answers = {
    occupation: profile.occupation,
    bio: profile.bio,
    primaryGoal: profile.primaryGoal,
    targetAudience: profile.targetAudience,
    knownFor: profile.knownFor,
    topicsTheyKnow: profile.topics,
    topicsToAvoid: profile.avoidTopics,
    howTheyWantToSound: profile.voiceDescription,
  };
  return [
    "## Onboarding answers",
    JSON.stringify(answers, null, 2),
    "",
    calibration.length
      ? `## Voice calibration (${calibration.length} replies they wrote)`
      : "## Voice calibration\nSkipped: no writing samples.",
    ...calibration.map(
      (sample, index) =>
        `${index + 1}. Post: ${sample.promptPost}\n   Their reply: ${sample.userReply}`,
    ),
    ...(opinions.length
      ? [
          "",
          `## Opinions they wrote down (${opinions.length})`,
          ...opinions.map((sample, index) => `${index + 1}. ${sample.userReply}`),
        ]
      : []),
    ...(posted.length
      ? [
          "",
          `## Replies they posted through Scout (${posted.length}, final text after their edits)`,
          ...posted.map(
            (item, index) =>
              `${index + 1}. Post by @${item.authorHandle ?? "unknown"}: ${item.post}\n   Their reply: ${item.reply}`,
          ),
        ]
      : []),
  ].join("\n");
}

/**
 * Day 14 cold start: onboarding answers + voice calibration → the same Scout
 * Brain schema analyzeUser() produces from X history. Rebuilding later also
 * reads the opinions they wrote down and the replies they posted through
 * Scout. Keeps the user's brain edits, Memory and Learning Profile.
 */
export async function buildColdStartBrain(
  profileId: string,
): Promise<{ sampleCount: number; opinionCount: number; postedCount: number }> {
  const [profile, samples, posted] = await Promise.all([
    getProfileById(profileId),
    getVoiceSamples(profileId),
    getPostedReplies(profileId, MAX_POSTED_REPLIES),
  ]);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const response = await getOpenAI().responses.parse({
    model: AI_MODELS.brain,
    instructions: INSTRUCTIONS,
    input: buildInput(profile, samples, posted),
    text: { format: zodTextFormat(scoutBrainAnalysisSchema, "scout_brain") },
  });
  await recordAiUsage({ profileId, operation: "brain_creation" }, response);
  const analysis = response.output_parsed;
  if (!analysis) throw new Error("OpenAI returned no structured Scout Brain output.");

  // Counted in code from what they actually wrote, never estimated
  const writing = [
    ...samples.map((sample) => ({ content: sample.userReply })),
    ...posted.map((item) => ({ content: item.reply })),
  ];
  analysis.voice.signaturePhrases = analysis.voice.signaturePhrases.map(({ phrase }) => ({
    phrase,
    frequency: phraseFrequency(phrase, writing),
  }));
  // There are no posts to reference
  analysis.voice.examplePostIds = [];
  for (const topic of analysis.interests.topics) topic.examplePostIds = [];
  for (const opinion of analysis.interests.opinions) opinion.examplePostIds = [];

  await updateProfileBrain(profileId, {
    analysis,
    measured: measureVoice(writing, { allReplies: true }),
    postCount: 0,
    holdoutPostIds: [],
    model: response.model,
    basis: "onboarding",
  });
  return {
    sampleCount: samples.filter((sample) => sample.source === "onboarding").length,
    opinionCount: samples.filter((sample) => sample.source === "opinion").length,
    postedCount: posted.length,
  };
}
