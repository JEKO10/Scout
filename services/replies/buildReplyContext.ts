import "server-only";

import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getProfileById } from "@/db/queries/profiles";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import type { Opportunity } from "@/db/schema";
import { refreshLearning } from "@/services/learning/refreshLearning";
import { formatLearningForReply } from "@/services/learning/replyLearning";
import { formatMemoryForReply } from "@/services/memory/replyMemory";
import { hasTextBeyondLinks } from "@/services/scout-brain/prompt";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { pickRelevantPosts } from "@/services/scout-brain/retrieval";

import { formatBrainForWriting, topEmojis } from "./voiceContext";

/** Past posts sent as voice examples: enough for style, not the whole history */
const EXAMPLE_POSTS = 4;

export type ReplyContext = {
  brainJson: string;
  /** Their own writing: past posts, or onboarding replies for new creators */
  examples: string[];
  /** Little or no writing history: write conservatively (Day 14) */
  newCreator: boolean;
  /** Decided in code per variant: one call can't follow "about 3 in 10" */
  emoji: [string | null, string | null];
  /** Relevant slice of the user's history; null until there is some */
  memory: string | null;
  /** Learned writing preferences with evidence; null until learned */
  learning: string | null;
  /** Standing rules the user wrote themselves */
  rules: string[];
};

/**
 * Everything the Reply Engine needs for one opportunity: the effective Scout
 * Brain (who they are), the relevant slice of memory (what has happened), a
 * few relevant past posts, and the emoji decision. Null when the user
 * has no Scout Brain yet.
 */
export async function buildReplyContext(
  profileId: string,
  opportunity: Pick<Opportunity, "content" | "authorHandle" | "suggestedAngle">,
): Promise<ReplyContext | null> {
  const [profile, { memory, learning }] = await Promise.all([
    getProfileById(profileId),
    refreshLearning(profileId),
  ]);
  const brain = profile ? resolveScoutBrain(profile) : null;
  if (!brain) return null;

  // Never the eval holdout: those posts stay unseen for measuring the brain
  const holdout = new Set(brain.holdoutPostIds);
  const pool = (await getRecentPostsForProfile(profileId, 100)).filter(
    (post) => !holdout.has(post.platformPostId) && hasTextBeyondLinks(post.content),
  );

  // New creators (Day 14): their onboarding replies are their writing history
  const samples = pool.length === 0 ? await getVoiceSamples(profileId) : [];
  const writing = pool.length ? pool : samples.map((sample) => ({ content: sample.userReply }));
  const examples = pool.length
    ? pickRelevantPosts(pool, opportunity.content, EXAMPLE_POSTS).map((post) => post.content)
    : samples.map((sample) => `(replying to "${sample.promptPost}") ${sample.userReply}`);

  const emojiShare = brain.voice.measured?.emojiShare ?? 0;
  const emojis = topEmojis(writing);
  const drawEmoji = () =>
    emojis.length && Math.random() < emojiShare
      ? emojis[Math.floor(Math.random() * emojis.length)]
      : null;

  return {
    brainJson: formatBrainForWriting(brain),
    examples,
    newCreator: pool.length === 0,
    emoji: [drawEmoji(), drawEmoji()],
    memory: formatMemoryForReply(memory, opportunity),
    learning: formatLearningForReply(learning),
    rules: profile?.replyRules ?? [],
  };
}
