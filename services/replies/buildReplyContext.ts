import "server-only";

import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getProfileById } from "@/db/queries/profiles";
import type { Opportunity, Post } from "@/db/schema";
import { hasTextBeyondLinks } from "@/services/scout-brain/prompt";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { pickRelevantPosts } from "@/services/scout-brain/retrieval";

import { formatBrainForWriting, topEmojis } from "./voiceContext";

/** Past posts sent as voice examples: enough for style, not the whole history */
const EXAMPLE_POSTS = 4;

export type ReplyContext = {
  brainJson: string;
  examples: Post[];
  /** Decided in code per variant: one call can't follow "about 3 in 10" */
  emoji: { natural: string | null; strongerTake: string | null };
};

/**
 * Everything the Reply Engine needs for one opportunity: the effective Scout
 * Brain, a few relevant past posts, and the emoji decision. Null when the user
 * has no Scout Brain yet.
 */
export async function buildReplyContext(
  profileId: string,
  opportunity: Pick<Opportunity, "content">,
): Promise<ReplyContext | null> {
  const profile = await getProfileById(profileId);
  const brain = profile ? resolveScoutBrain(profile) : null;
  if (!brain) return null;

  // Never the eval holdout: those posts stay unseen for measuring the brain
  const holdout = new Set(brain.holdoutPostIds);
  const pool = (await getRecentPostsForProfile(profileId, 100)).filter(
    (post) => !holdout.has(post.platformPostId) && hasTextBeyondLinks(post.content),
  );

  const emojiShare = brain.voice.measured?.emojiShare ?? 0;
  const emojis = topEmojis(pool);
  const drawEmoji = () =>
    emojis.length && Math.random() < emojiShare
      ? emojis[Math.floor(Math.random() * emojis.length)]
      : null;

  return {
    brainJson: formatBrainForWriting(brain),
    examples: pickRelevantPosts(pool, opportunity.content, EXAMPLE_POSTS),
    emoji: { natural: drawEmoji(), strongerTake: drawEmoji() },
  };
}
