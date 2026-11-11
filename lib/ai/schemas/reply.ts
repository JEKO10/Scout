import { z } from "zod";

/** Two drafts in the styles the user picked, in that order. */
export const replyDraftsSchema = z.object({
  first: z.string().describe("The draft in the first requested style, as posted on X."),
  second: z
    .string()
    .describe(
      "The draft in the second requested style: its own structure, not a paraphrase of `first`.",
    ),
});

export type ReplyDrafts = z.infer<typeof replyDraftsSchema>;
