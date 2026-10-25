import "server-only";

import { zodTextFormat } from "openai/helpers/zod";

import { getOpenAI, OPENAI_MODEL } from "@/lib/ai/client";
import {
  type CandidateJudgment,
  candidateJudgmentBatchSchema,
} from "@/lib/ai/schemas/opportunity";
import type {
  BrainItem,
  ResolvedScoutBrain,
} from "@/services/scout-brain/resolveBrain";

const INSTRUCTIONS = `You are Scout's Opportunity Engine. For one user, you judge which posts on X are worth their time to reply to. You get their Scout Brain (interests, expertise, opinions, goals), and a batch of candidate posts by accounts they follow, each with a few of the user's own past posts on similar subjects.

Score every candidate:
- relevance 0–25: overlap with topics the user ACTUALLY posts about ("observed"). Adjacent or trendy is not relevant.
- goalAlignment 0–20: replying moves their primary goal with their target audience.
- expertiseFit 0–20: their observed or stated expertise, or an existing opinion, gives them standing. 0 when nothing in the brain applies.
- audienceValue 0–10: the people in this conversation are their target audience.
- novelty 0–10: room for a distinctive point instead of one more agreeing reply.

Calibration:
- Be strict. In a typical batch most posts should score low and only a few should be worth engaging.
- Popularity, big accounts and hot topics earn nothing by themselves. A viral AI tweet the user has nothing specific to say about scores low.
- Topics in lowConfidenceTopics, or outside the user's topics entirely, get low relevance and expertiseFit.
- Never invent expertise or opinions that are not in the Scout Brain or their past posts.

shouldEngage is true only when the user has something specific to add that serves their goal.
reason: speak to the user ("You've written about…") and cite their brain or past posts.
suggestedAngle: the one point only this user could add, grounded in their opinions or experience. It is an angle, not a reply draft.`;

const labels = (items: BrainItem[]) => items.map((item) => item.label);

/** Interests and goals in full; only a summary of voice, which matters for writing, not ranking. */
export function formatBrainForRanking(brain: ResolvedScoutBrain): string {
  const { voice, interests, goals } = brain;
  return JSON.stringify(
    {
      who: { summary: voice.summary, perspective: voice.perspective },
      interests: {
        topics: interests.topics.map((topic) => ({
          name: topic.label,
          evidence: topic.evidence,
          detail: topic.detail,
        })),
        expertise: interests.expertise,
        opinions: interests.opinions.map(({ topic, statement }) => ({ topic, statement })),
        recurringThemes: labels(interests.recurringThemes),
        lowConfidenceTopics: interests.lowConfidenceTopics.map((topic) => topic.name),
      },
      goals: {
        primaryGoal: goals.primaryGoal,
        targetAudience: labels(goals.targetAudience),
        knownFor: labels(goals.knownFor),
        desiredPositioning: goals.desiredPositioning,
      },
    },
    null,
    2,
  );
}

export type CandidateForJudgment = {
  candidateId: string;
  authorHandle: string;
  kind: string;
  hoursAgo: number;
  replies: number | null;
  content: string;
  /** The user's own past posts most related to this candidate */
  history: string[];
};

/**
 * One OpenAI call judges a whole batch. Returns judgments keyed by candidate
 * id; a candidate the model skipped is simply missing (it stays unscored).
 */
export async function judgeCandidates(
  brainJson: string,
  candidates: CandidateForJudgment[],
): Promise<Map<string, CandidateJudgment>> {
  const response = await getOpenAI().responses.parse({
    model: OPENAI_MODEL,
    instructions: INSTRUCTIONS,
    input: [
      `## Scout Brain\n${brainJson}`,
      `## Candidates (${candidates.length})`,
      JSON.stringify(candidates, null, 2),
    ].join("\n\n"),
    text: { format: zodTextFormat(candidateJudgmentBatchSchema, "candidate_judgments") },
  });
  if (!response.output_parsed) throw new Error("No candidate judgments returned.");

  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  return new Map(
    response.output_parsed.judgments
      .filter((judgment) => known.has(judgment.candidateId))
      .map((judgment) => [judgment.candidateId, judgment]),
  );
}
