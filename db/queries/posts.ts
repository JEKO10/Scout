import "server-only";

import { count, desc, eq, sql } from "drizzle-orm";

import db from "@/db";
import { type Post, postsTable, socialAccountsTable } from "@/db/schema";
import type { NormalizedPost } from "@/lib/x/types";

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
