import { z } from "zod";

// Temporary Day 6 eval outputs. Strict JSON schema: every field required.

export const engagementDecisionSchema = z.object({
  shouldEngage: z
    .boolean()
    .describe("True only if a reply from this person would add real value."),
  relevance: z
    .enum(["high", "medium", "low", "none"])
    .describe("How close the post is to what this person actually knows and cares about."),
  why: z
    .string()
    .describe("One or two sentences explaining the decision, citing the Scout Brain."),
  relevantExpertise: z
    .string()
    .nullable()
    .describe("The specific expertise from the Scout Brain that applies, or null."),
  relevantOpinion: z
    .string()
    .nullable()
    .describe("An existing opinion from the Scout Brain that applies, or null."),
  valueAdd: z
    .string()
    .nullable()
    .describe(
      "What this person could add that the average reply would not. Null if nothing specific.",
    ),
});

export const testReplySchema = z.object({
  reply: z.string().describe("The reply text, exactly as it would be posted on X."),
});

export type EngagementDecision = z.infer<typeof engagementDecisionSchema>;
export type TestReply = z.infer<typeof testReplySchema>;
