import "server-only";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import db from "@/db";
import { type Post, postsTable, socialAccountsTable } from "@/db/schema";
import type { NormalizedPost } from "@/lib/posts/types";

/**
 * Idempotent: posts are keyed by the UNIQUE platformPostId, so syncing the
 * same account twice updates existing rows instead of duplicating them.
 */
export async function savePosts(
  socialAccountId: string,
  posts: NormalizedPost[],
): Promise<void> {
  if (posts.length === 0) return;

  await db
    .insert(postsTable)
    .values(posts.map((post) => ({ socialAccountId, ...post })))
    .onConflictDoUpdate({
      target: postsTable.platformPostId,
      // Text can be edited and metrics keep growing; refresh both
      set: {
        content: sql`excluded."content"`,
        metrics: sql`excluded."metrics"`,
        updatedAt: new Date(),
      },
    });
}

export async function countPostsBySocialAccount(
  socialAccountId: string,
): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(postsTable)
    .where(eq(postsTable.socialAccountId, socialAccountId));
  return result.value;
}

/** A profile's most recent posts across all its connected accounts. */
export async function getRecentPostsForProfile(
  profileId: string,
  limit: number,
): Promise<Post[]> {
  const rows = await db
    .select({ post: postsTable })
    .from(postsTable)
    .innerJoin(
      socialAccountsTable,
      eq(postsTable.socialAccountId, socialAccountsTable.id),
    )
    .where(eq(socialAccountsTable.profileId, profileId))
    .orderBy(desc(postsTable.publishedAt))
    .limit(limit);
  return rows.map((row) => row.post);
}

/** A profile's posts by platform ID, e.g. a Scout Brain's holdout set. */
export async function getProfilePostsByPlatformIds(
  profileId: string,
  platformPostIds: string[],
): Promise<Post[]> {
  if (platformPostIds.length === 0) return [];

  const rows = await db
    .select({ post: postsTable })
    .from(postsTable)
    .innerJoin(
      socialAccountsTable,
      eq(postsTable.socialAccountId, socialAccountsTable.id),
    )
    .where(
      and(
        eq(socialAccountsTable.profileId, profileId),
        inArray(postsTable.platformPostId, platformPostIds),
      ),
    )
    .orderBy(desc(postsTable.publishedAt));
  return rows.map((row) => row.post);
}
