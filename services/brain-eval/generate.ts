import "server-only";

import { zodTextFormat } from "openai/helpers/zod";

import type { Post } from "@/db/schema";
import { getOpenAI, OPENAI_MODEL } from "@/lib/ai/client";
import {
  type EngagementDecision,
  engagementDecisionSchema,
  testReplySchema,
} from "@/lib/ai/schemas/brainEval";

const DECISION_INSTRUCTIONS = `You decide whether a specific person should reply to a post on X. You are given their Scout Brain (voice, interests, goals) and the post.

Be selective. Most posts are not worth this person's reply. Say yes only when ALL of these hold:
- The post touches a topic, expertise area or existing opinion in their Scout Brain with "observed" or "stated" evidence.
- They could add something specific that an average reply would not: a fact, a distinction, a counter-argument or first-hand context grounded in their brain.
- Replying serves their goal with their target audience.

Say no when:
- The subject is popular or adjacent but they have nothing distinctive to add.
- It falls under their lowConfidenceTopics or outside their topics entirely.
- A reply could only be generic agreement, a pleasantry or self-promotion.

Never invent expertise or opinions that are not in the Scout Brain.`;

const REPLY_INSTRUCTIONS = `You write one reply on X, as the person described in the Scout Brain, to the given post. You are also given a few of their real past posts as voice examples.

Rules:
- Sound exactly like them: same perspective (personal "I" or institutional "we"), tone, sentence length, vocabulary, capitalization and emoji habits.
- Emoji: follow the "For this reply" instruction exactly. Exclamation marks and lowercase starts follow their measuredHabits shares. Keep the casual markers they really use; do not sand them off, and do not invent slang they never use.
- Signature phrases follow their frequency: "rare" almost never, "occasional" in about one reply in five, "frequent" in about half. Never more than one per reply.
- Aim for their median reply length; go longer only when the point truly needs it.
- Make one specific point grounded in their interests, expertise or existing opinions. Disagree when their opinions conflict with the post; do not default to agreeing.
- Do not restate or summarize the original post.
- Never use their promotional patterns, links, calls to action or self-promotion.
- Never claim experience, credentials or knowledge the Scout Brain does not support.
- No AI clichés: "Great point", "This!", "Absolutely", "It's worth noting", "In today's world", "game-changer", "delve", "navigate", "landscape".
- A reply is short: at most 280 characters, usually one to three sentences.
- Write in the language of the original post if the person writes in that language; otherwise their main language.`;

function postBlock(authorHandle: string, content: string) {
  return `## Post to reply to (by @${authorHandle})\n${content}`;
}

function examplesBlock(examples: Post[]) {
  return [
    "## Their past posts (voice examples)",
    ...examples.map((post, index) => `${index + 1}. ${post.content}`),
  ].join("\n");
}

export async function decideEngagement(
  brainJson: string,
  post: { authorHandle: string; content: string },
): Promise<EngagementDecision> {
  const response = await getOpenAI().responses.parse({
    model: OPENAI_MODEL,
    instructions: DECISION_INSTRUCTIONS,
    input: `## Scout Brain\n${brainJson}\n\n${postBlock(post.authorHandle, post.content)}`,
    text: { format: zodTextFormat(engagementDecisionSchema, "engagement_decision") },
  });
  if (!response.output_parsed) throw new Error("No engagement decision returned.");
  return response.output_parsed;
}

/**
 * Temporary Day 6 reply generator, used only to test the Scout Brain.
 * Not the Day 11 Reply Engine.
 */
export async function generateTestReply(
  brainJson: string,
  post: { authorHandle: string; content: string },
  examples: Post[],
  emoji: string | null,
): Promise<string> {
  // Decided by the caller: one call can't follow "about 3 replies in 10"
  const emojiDirective = emoji
    ? `## For this reply\nInclude exactly one emoji, ${emoji}, where it fits naturally.`
    : "## For this reply\nUse no emoji.";

  const response = await getOpenAI().responses.parse({
    model: OPENAI_MODEL,
    instructions: REPLY_INSTRUCTIONS,
    input: [
      `## Scout Brain\n${brainJson}`,
      examplesBlock(examples),
      postBlock(post.authorHandle, post.content),
      emojiDirective,
    ].join("\n\n"),
    text: { format: zodTextFormat(testReplySchema, "test_reply") },
  });
  if (!response.output_parsed) throw new Error("No reply returned.");
  return response.output_parsed.reply.trim();
}
