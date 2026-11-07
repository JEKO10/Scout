import "server-only";

import { zodTextFormat } from "openai/helpers/zod";

import { getOpportunityForProfile } from "@/db/queries/opportunities";
import { type ReplyPair, saveReplyDrafts } from "@/db/queries/replies";
import { getOpenAI, OPENAI_MODEL } from "@/lib/ai/client";
import { replyDraftsSchema } from "@/lib/ai/schemas/reply";

import { buildReplyContext, type ReplyContext } from "./buildReplyContext";

const INSTRUCTIONS = `You write replies on X for one specific person, described by their Scout Brain, using a few of their real past posts as voice examples. For one post you write two drafts.

Both drafts:
- Sound exactly like them: perspective ("I" or "we"), tone, sentence length, vocabulary, capitalization, emoji habits and measuredHabits. Aim near their median reply length.
- Build on the suggested angle. It is the point to make; say it in their words, don't copy it.
- Add something to the conversation: a specific point, distinction, example or experience from their brain or past posts.
- Never restate or summarize the original post.
- Never claim experiences, numbers, products or expertise that aren't in the Scout Brain or their past posts.
- Don't default to disagreeing. If they would agree, agree and add something.
- No openers like "Great point", "Couldn't agree more", "This is so true", "Absolutely", "100%".
- No AI or corporate clichés: "delve", "game-changer", "landscape", "navigate", "leverage", "In today's world", "It's worth noting".
- No hashtags, links or self-promotion, and never their promotional patterns.
- Signature phrases follow their frequency, at most one per draft.
- Emoji: follow each draft's emoji instruction exactly.
- At most 280 characters each.
- Write in the original post's language if they write in it; otherwise their main language.

natural: what they would most likely write on first instinct.
strongerTake: the same person, firmer: a clearer stance or sharper argument with a different structure from natural, not a paraphrase of it. Bolder, never ruder, and still true to their opinions.

Learned preferences (when given) come from the user's own repeated edits and choices, each with its evidence. They outrank the Scout Brain's style guidance:
- replyLength is a hard limit: every draft must fit it.
- avoid and do are rules, not suggestions.
- overusedArguments: never make these points again.

New creator (when marked): they have little or no posting history. Write conservatively: general, well-reasoned points from their stated interests, and no personal anecdotes, numbers, projects or experiences unless their own replies contain them.

Memory (when given) is what has actually happened with this user:
- recentEdits show how they rewrote Scout drafts. Write the way they ended up writing.
- alreadyUsedArguments: do not make the same point again; find a different angle on the subject.
- thisPerson: they have replied to this account before. Don't repeat their last reply's wording.`;

const emojiInstruction = (emoji: string | null) =>
  emoji ? `exactly one emoji, ${emoji}, where it fits naturally` : "no emoji";

function buildInput(
  context: ReplyContext,
  opportunity: { authorHandle: string | null; content: string; reason: string | null; suggestedAngle: string | null },
): string {
  return [
    `## Scout Brain\n${context.brainJson}`,
    [
      context.newCreator
        ? "## Their own replies from onboarding (voice examples)"
        : "## Their past posts (voice examples)",
      ...context.examples.map((text, index) => `${index + 1}. ${text}`),
    ].join("\n"),
    context.newCreator &&
      "## New creator\nLittle or no posting history: write conservatively and invent no personal experience.",
    `## Post to reply to (by @${opportunity.authorHandle ?? "unknown"})\n${opportunity.content}`,
    `## Why they should join\n${opportunity.reason ?? "-"}`,
    `## Suggested angle\n${opportunity.suggestedAngle ?? "-"}`,
    context.learning && `## Learned preferences\n${context.learning}`,
    context.memory && `## Memory\n${context.memory}`,
    [
      "## Emoji",
      `natural: ${emojiInstruction(context.emoji.natural)}`,
      `strongerTake: ${emojiInstruction(context.emoji.strongerTake)}`,
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type GenerateRepliesResult =
  | { status: "not_found" }
  | { status: "no_brain" }
  | { status: "generated"; replies: ReplyPair };

/**
 * Day 11 Reply Engine: opportunity + suggested angle + Scout Brain + relevant
 * past posts → OpenAI structured output → two drafts saved as replies.
 */
export async function generateReplies(
  profileId: string,
  opportunityId: string,
): Promise<GenerateRepliesResult> {
  const opportunity = await getOpportunityForProfile(profileId, opportunityId);
  if (!opportunity) return { status: "not_found" };

  const context = await buildReplyContext(profileId, opportunity);
  if (!context) return { status: "no_brain" };

  const response = await getOpenAI().responses.parse({
    model: OPENAI_MODEL,
    instructions: INSTRUCTIONS,
    input: buildInput(context, opportunity),
    text: { format: zodTextFormat(replyDraftsSchema, "reply_drafts") },
  });
  const drafts = response.output_parsed;
  if (!drafts) throw new Error("OpenAI returned no reply drafts.");

  const replies = await saveReplyDrafts(opportunity.id, {
    natural: drafts.natural.trim(),
    strongerTake: drafts.strongerTake.trim(),
  });
  return { status: "generated", replies };
}
