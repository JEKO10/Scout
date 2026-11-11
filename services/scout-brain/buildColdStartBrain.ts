import "server-only";

import { zodTextFormat } from "openai/helpers/zod";

import { getProfileById, updateProfileBrain } from "@/db/queries/profiles";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import type { Profile, VoiceSample } from "@/db/schema";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import { scoutBrainAnalysisSchema } from "@/lib/ai/schemas/scoutBrain";
import { recordAiUsage } from "@/services/ai/usage";

import { measureVoice, phraseFrequency } from "./measureVoice";

const INSTRUCTIONS = `You are building a "Scout Brain" for a person who has little or no posting history on X. Scout uses it to find conversations they should join and to write replies that sound like them.

You get their onboarding answers and, when they did voice calibration, a few replies they wrote themselves to sample posts. Produce the same three parts as always: voice, interests, goals.

Separate what is declared from what is observed, and never invent:
- "stated": the user said it in onboarding (topics, expertise, goals, how they want to sound).
- "observed": visible in their own calibration replies (wording, stance, length, tone).
- "inferred": avoid. If you must, keep confidence low.
- Never invent past opinions, experiences, achievements, products or expertise. Opinions come only from stances they took in their calibration replies.
- When there isn't enough data for a field, say so plainly (e.g. humor: "Unknown: not enough writing samples yet").

Voice:
- Base voice on the calibration replies when present (observed); otherwise on their description of how they want to sound (stated), with low confidence.
- signaturePhrases only if a phrase actually appears in their replies; otherwise empty.
- examplePostIds must be empty: there are no posts.

Interests:
- topics: the topics they declared (evidence "stated", postCount 0). Mark a topic "observed" only if their replies show real depth on it.
- Topics they want to avoid go in lowConfidenceTopics with the reason "The user doesn't want to comment on this."

Goals come straight from their answers. Be honest in postingAlignment that there is no posting history yet.

Write all descriptions in English.`;

function buildInput(profile: Profile, samples: VoiceSample[]): string {
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
    samples.length
      ? `## Voice calibration (${samples.length} replies they wrote)`
      : "## Voice calibration\nSkipped: no writing samples.",
    ...samples.map(
      (sample, index) =>
        `${index + 1}. Post: ${sample.promptPost}\n   Their reply: ${sample.userReply}`,
    ),
  ].join("\n");
}

/**
 * Day 14 cold start: onboarding answers + voice calibration → the same Scout
 * Brain schema analyzeUser() produces from X history. Keeps the user's brain
 * edits, Memory and Learning Profile.
 */
export async function buildColdStartBrain(profileId: string): Promise<{ sampleCount: number }> {
  const [profile, samples] = await Promise.all([
    getProfileById(profileId),
    getVoiceSamples(profileId),
  ]);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const response = await getOpenAI().responses.parse({
    model: AI_MODELS.brain,
    instructions: INSTRUCTIONS,
    input: buildInput(profile, samples),
    text: { format: zodTextFormat(scoutBrainAnalysisSchema, "scout_brain") },
  });
  await recordAiUsage({ profileId, operation: "brain_creation" }, response);
  const analysis = response.output_parsed;
  if (!analysis) throw new Error("OpenAI returned no structured Scout Brain output.");

  // Counted in code from what they actually wrote, never estimated
  const writing = samples.map((sample) => ({ content: sample.userReply }));
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
  return { sampleCount: samples.length };
}
