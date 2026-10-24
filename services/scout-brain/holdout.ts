import { createHash } from "node:crypto";

const HOLDOUT_MAX = 10;
const HOLDOUT_SHARE = 0.2;

/**
 * Splits posts into a training set for the Scout Brain and a holdout set the
 * model never sees, so Day 6 evals compare generated text against real posts
 * without leakage. Selection is by hashed post ID: deterministic, independent
 * of post order, and spread across the whole time range.
 */
export function splitHoldout<T extends { platformPostId: string }>(
  posts: T[],
): { training: T[]; holdout: T[] } {
  const size = Math.min(HOLDOUT_MAX, Math.floor(posts.length * HOLDOUT_SHARE));
  const holdoutIds = new Set(
    posts
      .map((post) => ({
        id: post.platformPostId,
        rank: createHash("sha256").update(post.platformPostId).digest("hex"),
      }))
      .sort((a, b) => a.rank.localeCompare(b.rank))
      .slice(0, size)
      .map(({ id }) => id),
  );

  return {
    training: posts.filter((post) => !holdoutIds.has(post.platformPostId)),
    holdout: posts.filter((post) => holdoutIds.has(post.platformPostId)),
  };
}
