import "server-only";

import { and, desc, eq, gt, sql } from "drizzle-orm";

import db from "@/db";
import { type ImportedPost, importedPostsTable } from "@/db/schema";
import type { NormalizedCandidatePost } from "@/lib/posts/types";

/** Idempotent per profile: re-importing the same export adds nothing new. */
export async function saveImportedPosts(
  profileId: string,
  posts: NormalizedCandidatePost[],
): Promise<number> {
  if (posts.length === 0) return 0;

  const inserted = await db
    .insert(importedPostsTable)
    .values(
      posts.map((post) => ({
        profileId,
        platform: post.platform,
        platformPostId: post.platformPostId,
        authorHandle: post.authorHandle,
        content: post.content,
        url: post.url,
        kind: post.kind,
        metrics: post.metrics,
        postedAt: post.postedAt,
      })),
    )
    .onConflictDoNothing({
      target: [
        importedPostsTable.profileId,
        importedPostsTable.platform,
        importedPostsTable.platformPostId,
      ],
    })
    .returning({ id: importedPostsTable.id });
  return inserted.length;
}

/**
 * An author's imported posts, newest first. `importedAfter` filters by when
 * the post was imported, not when it was posted.
 */
export async function getImportedPostsByAuthor(
  profileId: string,
  authorHandle: string,
  { importedAfter, limit }: { importedAfter: Date | null; limit: number },
): Promise<ImportedPost[]> {
  return db
    .select()
    .from(importedPostsTable)
    .where(
      and(
        eq(importedPostsTable.profileId, profileId),
        sql`lower(${importedPostsTable.authorHandle}) = lower(${authorHandle})`,
        importedAfter ? gt(importedPostsTable.createdAt, importedAfter) : undefined,
      ),
    )
    .orderBy(desc(importedPostsTable.postedAt))
    .limit(limit);
}
