import { z } from "zod";

export const replyDraftsSchema = z.object({
  natural: z
    .string()
    .describe("The reply this person would most likely write themselves, as posted on X."),
  strongerTake: z
    .string()
    .describe(
      "A sharper version: a firmer stance or argument with its own structure, not a paraphrase of `natural`. Still something this person would say.",
    ),
});

export type ReplyDrafts = z.infer<typeof replyDraftsSchema>;
