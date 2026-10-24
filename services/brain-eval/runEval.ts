import "server-only";

import { createEvalRun, getEvalCases } from "@/db/queries/eval";
import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getProfileById } from "@/db/queries/profiles";
import type { EvalRun } from "@/db/schema";
import { OPENAI_MODEL } from "@/lib/ai/client";
import { hasTextBeyondLinks } from "@/services/scout-brain/prompt";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

import { formatBrainForPrompt, pickRelevantPosts, topEmojis } from "./context";
import { decideEngagement, generateTestReply } from "./generate";

// Parallel OpenAI calls per batch; keeps us clear of rate limits
const CONCURRENCY = 4;

export type RunBrainEvalResult =
  | { status: "no_brain" }
  | { status: "no_cases" }
  | { status: "done"; run: EvalRun; caseCount: number };

/**
 * For every eval case: an engagement decision and a test reply, both from the
 * current Scout Brain. Decision and reply are separate calls so neither biases
 * the other. Voice examples never include the brain's holdout posts.
 */
export async function runBrainEval(
  profileId: string,
): Promise<RunBrainEvalResult> {
  const [profile, cases, recentPosts] = await Promise.all([
    getProfileById(profileId),
    getEvalCases(profileId),
    getRecentPostsForProfile(profileId, 100),
  ]);
  const brain = profile ? resolveScoutBrain(profile) : null;
  if (!brain) return { status: "no_brain" };
  if (cases.length === 0) return { status: "no_cases" };

  const holdout = new Set(brain.holdoutPostIds);
  const examplePool = recentPosts.filter(
    (post) => !holdout.has(post.platformPostId) && hasTextBeyondLinks(post.content),
  );
  const brainJson = formatBrainForPrompt(brain);
  const emojiShare = brain.voice.measured?.emojiShare ?? 0;
  const emojis = topEmojis(examplePool);

  const results = [];
  for (let i = 0; i < cases.length; i += CONCURRENCY) {
    const batch = cases.slice(i, i + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map(async (evalCase) => {
          const examples = pickRelevantPosts(examplePool, evalCase.content);
          const [decision, reply] = await Promise.all([
            decideEngagement(brainJson, evalCase),
            generateTestReply(
              brainJson,
              evalCase,
              examples,
              // Same share of replies with an emoji as their real posts
              emojis.length && Math.random() < emojiShare
                ? emojis[Math.floor(Math.random() * emojis.length)]
                : null,
            ),
          ]);
          return {
            caseId: evalCase.id,
            decision,
            reply,
            contextPostIds: examples.map((post) => post.platformPostId),
          };
        }),
      )),
    );
  }

  const run = await createEvalRun(profileId, {
    brainAnalyzedAt: brain.analyzedAt,
    model: OPENAI_MODEL,
    results,
  });
  return { status: "done", run, caseCount: results.length };
}
