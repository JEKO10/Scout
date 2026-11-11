import "server-only";

import { zodTextFormat } from "openai/helpers/zod";

import { getOpportunityForProfile } from "@/db/queries/opportunities";
import { getProfileById } from "@/db/queries/profiles";
import { getCurrentReplies, type ReplySet, saveReplyDrafts } from "@/db/queries/replies";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import { replyDraftsSchema } from "@/lib/ai/schemas/reply";
import { splitQuotedPost } from "@/lib/posts/quotedPost";
import { REPLY_STYLE_INFO, type ReplyStyle } from "@/lib/replies/styles";
import { recordAiUsage } from "@/services/ai/usage";
import { getUsageBudget } from "@/services/billing/budget";

import { buildReplyContext, type ReplyContext } from "./buildReplyContext";

const INSTRUCTIONS = `You write replies on X for one specific person, described by their Scout Brain, using a few of their real past posts as voice examples. For one post you write two drafts, each in a style the user picked (given with the post).

Both drafts:
- Sound exactly like them: perspective ("I" or "we"), tone, sentence length, vocabulary, capitalization, emoji habits and measuredHabits. Aim near their median reply length.
- Build on the suggested angle. It is the point to make; say it in their words, don't copy it.
- Add something to the conversation: a specific point, distinction, example or experience from their brain or past posts.
- Never restate or summarize the original post.
- When the post quotes another post: you reply to the quoting author, about their take. The quoted post is context only, written by someone else; never attribute its words to the author, and don't answer the quoted author.
- Never claim experiences, numbers, products or expertise that aren't in the Scout Brain or their past posts.
- Don't default to disagreeing. If they would agree, agree and add something.
- No openers like "Great point", "Couldn't agree more", "This is so true", "Absolutely", "100%".
- No AI or corporate clichés: "delve", "game-changer", "landscape", "navigate", "leverage", "In today's world", "It's worth noting".
- No hashtags, links or self-promotion, and never their promotional patterns.
- Signature phrases follow their frequency, at most one per draft.
- Emoji: follow each draft's emoji instruction exactly, unless the user instruction or a user rule says something about emoji; then theirs wins.
- At most 280 characters each.
- Write in the original post's language if they write in it; otherwise their main language.

Styles: each draft follows its requested style, which decides its shape (a one-liner is one sentence, a question asks one), while the voice stays theirs. The two drafts differ in structure; the second is never a paraphrase of the first.

Learned preferences (when given) come from the user's own repeated edits and choices, each with its evidence. They outrank the Scout Brain's style guidance:
- replyLength is a hard limit: every draft must fit it.
- avoid and do are rules, not suggestions.
- overusedArguments: never make these points again.

User rules (when given) are rules the user wrote themselves for every reply. Follow each one exactly; they outrank the Scout Brain and learned preferences. The only thing they never override: don't invent experiences.

User instruction (when given) is what the user asked to change on this regeneration, usually about the previous drafts shown with it. Apply it to both drafts; it outranks everything except user rules and honesty. Change what they asked for and keep what they didn't mention.

New creator (when marked): they have little or no posting history. Write conservatively: general, well-reasoned points from their stated interests, and no personal anecdotes, numbers, projects or experiences unless their own replies contain them.

Memory (when given) is what has actually happened with this user:
- recentEdits show how they rewrote Scout drafts. Write the way they ended up writing.
- alreadyUsedArguments: do not make the same point again; find a different angle on the subject.
- thisPerson: they have replied to this account before. Don't repeat their last reply's wording.`;

const emojiInstruction = (emoji: string | null) =>
  emoji ? `exactly one emoji, ${emoji}, where it fits naturally` : "no emoji";

type Revision = {
  instruction: string;
  /** The drafts on screen when the user asked for the change */
  previous: string[];
};

function buildInput(
  context: ReplyContext,
  opportunity: { authorHandle: string | null; content: string; reason: string | null; suggestedAngle: string | null },
  styles: [ReplyStyle, ReplyStyle],
  revision: Revision | null,
): string {
  const [first, second] = styles.map((style) => REPLY_STYLE_INFO[style]);
  const post = splitQuotedPost(opportunity.content);
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
    `## Post to reply to (by @${opportunity.authorHandle ?? "unknown"})\n${post.own}`,
    post.quoted &&
      `## The post they are quoting (by another account; context only, not their words)\n${post.quoted}`,
    `## Why they should join\n${opportunity.reason ?? "-"}`,
    `## Suggested angle\n${opportunity.suggestedAngle ?? "-"}`,
    [
      "## Styles",
      `first (${first.label}): ${first.prompt}`,
      `second (${second.label}): ${second.prompt}`,
    ].join("\n"),
    context.learning && `## Learned preferences\n${context.learning}`,
    context.memory && `## Memory\n${context.memory}`,
    context.rules.length > 0 &&
      ["## User rules", ...context.rules.map((rule) => `- ${rule}`)].join("\n"),
    revision &&
      [
        revision.previous.length > 0 && "## Previous drafts",
        ...revision.previous.map((text, index) => `${index + 1}. ${text}`),
        `## User instruction\n${revision.instruction}`,
      ]
        .filter(Boolean)
        .join("\n"),
    [
      // Drawn from their habits; the user's own words about emoji override it
      context.rules.length > 0 || revision
        ? "## Emoji (default from their habits; a user rule or instruction about emoji overrides it)"
        : "## Emoji",
      `first: ${emojiInstruction(context.emoji[0])}`,
      `second: ${emojiInstruction(context.emoji[1])}`,
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type GenerateRepliesResult =
  | { status: "not_found" }
  | { status: "no_brain" }
  /** The plan's monthly reply generation budget is used up */
  | { status: "budget_exhausted" }
  | { status: "generated"; replies: ReplySet };

/**
 * Day 11 Reply Engine: opportunity + suggested angle + Scout Brain + relevant
 * past posts → OpenAI structured output → two drafts, in the two styles the
 * user picked, saved as replies. One AI call whatever the styles.
 */
export async function generateReplies(
  profileId: string,
  opportunityId: string,
  {
    styles,
    instruction = null,
  }: { styles: [ReplyStyle, ReplyStyle]; instruction?: string | null },
): Promise<GenerateRepliesResult> {
  const [opportunity, profile] = await Promise.all([
    getOpportunityForProfile(profileId, opportunityId),
    getProfileById(profileId),
  ]);
  if (!opportunity || !profile) return { status: "not_found" };
  // Checked before the AI call; two drafts generated at the same moment can
  // overshoot the budget by at most those calls
  if ((await getUsageBudget(profile)).remaining.replyUsd <= 0) {
    return { status: "budget_exhausted" };
  }

  const context = await buildReplyContext(profileId, opportunity);
  if (!context) return { status: "no_brain" };

  // "Shorter" means shorter than what's on screen: send the current drafts along
  const current = instruction
    ? (await getCurrentReplies(profileId, [opportunity.id])).get(opportunity.id)
    : undefined;
  const revision: Revision | null = instruction
    ? {
        instruction,
        previous: (current ?? []).map((reply) => reply.content),
      }
    : null;

  const response = await getOpenAI().responses.parse({
    model: AI_MODELS.reply,
    instructions: INSTRUCTIONS,
    input: buildInput(context, opportunity, styles, revision),
    text: { format: zodTextFormat(replyDraftsSchema, "reply_drafts") },
  });
  // Tied to the run that found the opportunity, for per-run cost analytics
  await recordAiUsage(
    { profileId, operation: "reply_generation", scoutRunId: opportunity.scoutRunId },
    response,
  );
  const drafts = response.output_parsed;
  if (!drafts) throw new Error("OpenAI returned no reply drafts.");

  const replies = await saveReplyDrafts(
    opportunity.id,
    [
      { style: styles[0], text: drafts.first.trim() },
      { style: styles[1], text: drafts.second.trim() },
    ],
    instruction,
  );
  return { status: "generated", replies };
}
