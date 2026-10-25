import { z } from "zod";

// The judgment part of opportunity scoring. Freshness, duplicates and
// "already processed" are decided in code, not here.

export const candidateJudgmentSchema = z.object({
  candidateId: z.string().describe("The candidate's id, copied exactly."),
  relevance: z
    .number()
    .int()
    .describe(
      "0–25. How close the post is to topics this user actually posts about (observed), not adjacent buzz.",
    ),
  goalAlignment: z
    .number()
    .int()
    .describe("0–20. How much replying moves the user's stated goal with their target audience."),
  expertiseFit: z
    .number()
    .int()
    .describe(
      "0–20. Whether the user's observed or stated expertise or existing opinions give them standing here. 0 if none.",
    ),
  audienceValue: z
    .number()
    .int()
    .describe(
      "0–10. Whether the people in this conversation are the user's target audience.",
    ),
  novelty: z
    .number()
    .int()
    .describe(
      "0–10. Room for a distinctive contribution rather than one more 'agree!' reply.",
    ),
  shouldEngage: z
    .boolean()
    .describe("True only if this user has something specific to add that serves their goal."),
  reason: z
    .string()
    .describe(
      "Why THIS user should join, in one or two sentences addressed to them ('You've written…'). Cite their Scout Brain. If they shouldn't, say why not.",
    ),
  suggestedAngle: z
    .string()
    .describe(
      "The specific point only this user could add, grounded in their opinions or experience, in one sentence. Not a reply draft. Empty string if they shouldn't engage.",
    ),
});

export const candidateJudgmentBatchSchema = z.object({
  judgments: z
    .array(candidateJudgmentSchema)
    .describe("Exactly one judgment per candidate, in any order."),
});

export type CandidateJudgment = z.infer<typeof candidateJudgmentSchema>;
