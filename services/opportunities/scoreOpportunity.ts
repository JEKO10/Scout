import "server-only";

import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseUsage } from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";

import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import {
  type CandidateJudgment,
  candidateJudgmentBatchSchema,
} from "@/lib/ai/schemas/opportunity";
import { type AiUsageContext, recordAiUsage } from "@/services/ai/usage";
import type {
  BrainItem,
  ResolvedScoutBrain,
} from "@/services/scout-brain/resolveBrain";

// Prompt v1: the production prompt since Day 9. Never edit it in place; a
// change is a new version, evaluated first (lib/evals/scoring).
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
- Some users are new and have no posting history: "history" may then be replies they wrote during onboarding, or empty. Missing history is never a reason to lower a score. Judge "stated" interests and expertise at face value; the score reflects the opportunity, not the age of their account.

Quotes: content is what the candidate's author wrote; quotedPost is the post they quote, by another account, and only context. Judge the chance to reply to the candidate's author about their take, never as if the quoted words were theirs.

shouldEngage is true only when the user has something specific to add that serves their goal.
reason: speak to the user ("You've written about…") and cite their brain or past posts.
suggestedAngle: the one point only this user could add, grounded in their opinions or experience. It is an angle, not a reply draft.`;

// Prompt v2 (Day 20, experimental): v1's rules and scale unchanged, plus an
// output budget. Most of v1's cost is output: long reasons and angles for
// posts the user never sees.
const INSTRUCTIONS_V2 = `${INSTRUCTIONS}

Output budget (keep every text field short; the scores matter most):
- reason: at most 20 words. When shouldEngage is false: at most 8 words.
- suggestedAngle: at most 20 words; an empty string when shouldEngage is false.
- topic: 1–3 words.`;

// Prompt v3 (Day 20, experimental): v1 unchanged, plus reply potential and
// the user's own past judgments as calibration examples (sent in the input,
// see PreferenceExample). Nothing from v2's output budget.
const INSTRUCTIONS_V3 = `${INSTRUCTIONS}

Reply potential decides. A topic that matches the Scout Brain is not enough: ask whether this user has a specific opinion, argument, counterpoint or first-hand experience that would make their reply worth reading. Debatable claims and predictions in their area usually have it; announcements, follower milestones, product promotion and jokes usually don't, even on their topics. Put that judgment into relevance, novelty and shouldEngage.

This user's own judgments: the input may list posts this user rated themselves (strong: they would reply right away; acceptable: maybe; weak: on topic but nothing to add; irrelevant: not for them). They show this user's taste better than the Brain does. Calibrate to them: score candidates like their strong examples high and candidates like their weak or irrelevant examples low, even when the topic matches the Brain. They are examples, not candidates: never return judgments for them.`;

export const SCORING_PROMPTS = {
  v1: {
    instructions: INSTRUCTIONS,
    /** Pretty-printed, exactly as in production since Day 9 */
    formatJson: (value: unknown) => JSON.stringify(value, null, 2),
  },
  v2: {
    instructions: INSTRUCTIONS_V2,
    /** Compact JSON: indentation is input tokens with no meaning */
    formatJson: (value: unknown) => JSON.stringify(value),
  },
  v3: {
    instructions: INSTRUCTIONS_V3,
    /** As v1 */
    formatJson: (value: unknown) => JSON.stringify(value, null, 2),
  },
} as const;

/** A post the user rated themselves; v3 sends a few as calibration examples. */
export type PreferenceExample = {
  verdict: "strong" | "acceptable" | "weak" | "irrelevant";
  authorHandle: string;
  content: string;
  quotedPost?: string;
};

export type ScoringPromptVersion = keyof typeof SCORING_PROMPTS;

/** One model-call configuration: which model, prompt and effort judge a batch. */
export type ScoringStage = {
  model: string;
  prompt: ScoringPromptVersion;
  /** Omitted: the model's default (gpt-5.5: medium), as in production */
  reasoningEffort?: ReasoningEffort;
  verbosity?: "low" | "medium" | "high";
  batchSize: number;
};

const labels = (items: BrainItem[]) => items.map((item) => item.label);

/** Interests and goals in full; only a summary of voice, which matters for writing, not ranking. */
export function brainForRanking(brain: ResolvedScoutBrain) {
  const { voice, interests, goals } = brain;
  return {
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
  };
}

export type RankingBrain = ReturnType<typeof brainForRanking>;

export type CandidateForJudgment = {
  candidateId: string;
  authorHandle: string;
  kind: string;
  hoursAgo: number;
  replies: number | null;
  /** What the candidate's author wrote */
  content: string;
  /** Quotes only: the post they quote, by another account */
  quotedPost?: string;
  /** The user's own past posts most related to this candidate */
  history: string[];
};

/** Production scoring since Day 9: gpt-5.5 (or OPENAI_SCORING_MODEL), prompt v1, batches of 10. */
export const BASELINE_STAGE: ScoringStage = {
  model: AI_MODELS.scoring,
  prompt: "v1",
  batchSize: 10,
};

const SCORING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * Production scoring: the baseline (prompt v1) with low reasoning effort,
 * since Day 21. Measured on 40 human-rated posts over 3 runs each: half the
 * run-to-run noise of the model default (mean change 3.7 vs 6.4 points,
 * 1–3 vs 7 decision flips, rank stability 0.95–0.97 vs 0.87), equal or
 * better recall, precision and AUC, the same score level (−0.2 points, so
 * thresholds still fit), ~40% cheaper and twice as fast.
 *
 * OPENAI_SCORING_REASONING_EFFORT overrides it; "default" sends no reasoning
 * parameter at all: the exact pre-Day-21 request (rollback).
 */
export function productionScoringStage(effort = process.env.OPENAI_SCORING_REASONING_EFFORT ?? "low"): ScoringStage {
  if (effort === "default") return BASELINE_STAGE;
  if (!(SCORING_EFFORTS as readonly string[]).includes(effort)) {
    console.warn(`Unknown OPENAI_SCORING_REASONING_EFFORT "${effort}"; using low.`);
    return { ...BASELINE_STAGE, reasoningEffort: "low" };
  }
  return { ...BASELINE_STAGE, reasoningEffort: effort as ReasoningEffort };
}

/** The exact request one batch sends. For v1 it is the Day 9 request, unchanged. */
export function buildJudgmentRequest(
  stage: ScoringStage,
  brain: RankingBrain,
  candidates: CandidateForJudgment[],
  {
    cacheKey,
    maxOutputTokens,
    preferenceExamples,
  }: {
    cacheKey?: string;
    /** Evaluation only: a hard cap, so a call's cost has a known upper bound */
    maxOutputTokens?: number;
    /** Prompt v3 only: the user's own rated posts */
    preferenceExamples?: PreferenceExample[];
  } = {},
) {
  const prompt = SCORING_PROMPTS[stage.prompt];
  const examples =
    stage.prompt === "v3" && preferenceExamples?.length
      ? [`## This user's own judgments (examples, not candidates)\n${prompt.formatJson(preferenceExamples)}`]
      : [];
  return {
    model: stage.model,
    instructions: prompt.instructions,
    input: [
      `## Scout Brain\n${prompt.formatJson(brain)}`,
      ...examples,
      `## Candidates (${candidates.length})`,
      prompt.formatJson(candidates),
    ].join("\n\n"),
    text: {
      format: zodTextFormat(candidateJudgmentBatchSchema, "candidate_judgments"),
      ...(stage.verbosity && { verbosity: stage.verbosity }),
    },
    ...(stage.reasoningEffort && { reasoning: { effort: stage.reasoningEffort } }),
    // Every batch of one user starts with the same brain: one cache route.
    // Not on v1, so the production request stays exactly as it was.
    ...(cacheKey && stage.prompt !== "v1" && { prompt_cache_key: cacheKey }),
    ...(maxOutputTokens && { max_output_tokens: maxOutputTokens }),
  };
}

export type JudgmentResponse = {
  judgments: Map<string, CandidateJudgment>;
  /** False when the output didn't parse into the schema */
  parsed: boolean;
  /** Judgments for ids that weren't in the batch (dropped) */
  unknownIds: number;
  /** As the API reports it, e.g. "gpt-5.5-2026-04-23" */
  model: string;
  usage: ResponseUsage | null;
  latencyMs: number;
};

/**
 * One OpenAI call judges a batch. No database access: production records
 * usage around it (judgeCandidates); the offline evaluation doesn't.
 */
export async function requestJudgments(
  stage: ScoringStage,
  brain: RankingBrain,
  candidates: CandidateForJudgment[],
  options: {
    cacheKey?: string;
    maxOutputTokens?: number;
    preferenceExamples?: PreferenceExample[];
    /** Evaluation: no SDK retries, so every billed request is one the budget saw */
    maxRetries?: number;
  } = {},
): Promise<JudgmentResponse> {
  const started = Date.now();
  const { maxRetries, ...requestOptions } = options;
  const response = await getOpenAI().responses.parse(
    buildJudgmentRequest(stage, brain, candidates, requestOptions),
    maxRetries === undefined ? undefined : { maxRetries },
  );
  const latencyMs = Date.now() - started;
  const returned = response.output_parsed?.judgments ?? [];
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  const judgments = new Map(
    returned
      .filter((judgment) => known.has(judgment.candidateId))
      .map((judgment) => [judgment.candidateId, judgment]),
  );
  return {
    judgments,
    parsed: Boolean(response.output_parsed),
    unknownIds: returned.length - judgments.size,
    model: response.model,
    usage: response.usage ?? null,
    latencyMs,
  };
}

/**
 * Production: one batch through `stage`, its usage recorded for the run.
 * Returns judgments keyed by candidate id; a candidate the model skipped is
 * simply missing (it stays unscored).
 */
export async function judgeCandidates(
  brain: RankingBrain,
  candidates: CandidateForJudgment[],
  usage: AiUsageContext,
  stage: ScoringStage = BASELINE_STAGE,
): Promise<JudgmentResponse> {
  const result = await requestJudgments(stage, brain, candidates, { cacheKey: usage.profileId });
  await recordAiUsage(usage, { model: result.model, usage: result.usage });
  if (!result.parsed) throw new Error("No candidate judgments returned.");
  return result;
}
