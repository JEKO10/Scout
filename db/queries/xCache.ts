import "server-only";

import { and, desc, eq, gte, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";

import db from "@/db";
import {
  scoutCandidatesTable,
  watchlistAccountsTable,
  type XAccount,
  xAccountsTable,
  type XPost,
  xPostsTable,
} from "@/db/schema";
import { splitQuotedPost } from "@/lib/posts/quotedPost";
import type { NormalizedCandidatePost } from "@/lib/posts/types";
import type { XScanCursor } from "@/lib/scout/types";

/**
 * The shared record for an X account, created on first use. A new record
 * starts from the lowest cursor any watcher had before Day 17, so no watcher
 * can miss posts between their old cursor and the shared one.
 */
export async function getOrCreateXAccount(platformUserId: string, handle: string): Promise<XAccount> {
  const [existing] = await db
    .select()
    .from(xAccountsTable)
    .where(eq(xAccountsTable.platformUserId, platformUserId));
  if (existing) return existing;

  const legacy = await db
    .select({ cursor: watchlistAccountsTable.xCursor })
    .from(watchlistAccountsTable)
    .where(eq(watchlistAccountsTable.platformUserId, platformUserId));
  const cursors = legacy.map((row) => row.cursor).filter((cursor) => cursor !== null);
  const lowest = cursors.sort((a, b) => (BigInt(a.sinceId) < BigInt(b.sinceId) ? -1 : 1))[0];

  await db
    .insert(xAccountsTable)
    .values({ platformUserId, handle, cursor: lowest ?? null })
    .onConflictDoNothing();
  const [created] = await db
    .select()
    .from(xAccountsTable)
    .where(eq(xAccountsTable.platformUserId, platformUserId));
  return created;
}

/** Fetched within the last `freshMinutes`, by the database clock. */
const freshWithin = (freshMinutes: number) =>
  sql`${xAccountsTable.lastFetchedAt} > now() - make_interval(mins => ${freshMinutes})`;

/**
 * Takes the fetch lock when the cache isn't fresh and nobody holds an
 * unexpired lock. One statement, so two instances can't both take it. Null:
 * fresh enough, or someone else is fetching. Times use the database clock.
 */
export async function acquireFetchLock(
  platformUserId: string,
  token: string,
  { freshMinutes, lockSeconds }: { freshMinutes: number; lockSeconds: number },
): Promise<XAccount | null> {
  const [account] = await db
    .update(xAccountsTable)
    .set({
      fetchLockToken: token,
      fetchLockedUntil: sql`now() + make_interval(secs => ${lockSeconds})`,
    })
    .where(
      and(
        eq(xAccountsTable.platformUserId, platformUserId),
        or(isNull(xAccountsTable.fetchLockedUntil), lt(xAccountsTable.fetchLockedUntil, sql`now()`)),
        or(isNull(xAccountsTable.lastFetchedAt), sql`not (${freshWithin(freshMinutes)})`),
      ),
    )
    .returning();
  return account ?? null;
}

/** Whether the cache is fresh, and whether another worker holds the lock. */
export async function getFetchState(
  platformUserId: string,
  freshMinutes: number,
): Promise<{ fresh: boolean; locked: boolean }> {
  const [row] = await db
    .select({
      fresh: sql<boolean>`coalesce(${freshWithin(freshMinutes)}, false)`,
      locked: sql<boolean>`coalesce(${xAccountsTable.fetchLockedUntil} > now(), false)`,
    })
    .from(xAccountsTable)
    .where(eq(xAccountsTable.platformUserId, platformUserId));
  return row ?? { fresh: false, locked: false };
}

function toCacheRow(post: NormalizedCandidatePost, authorPlatformUserId: string) {
  const { own, quoted } = splitQuotedPost(post.content);
  return {
    platformPostId: post.platformPostId,
    authorPlatformUserId,
    authorHandle: post.authorHandle,
    content: own,
    url: post.url,
    kind: post.kind,
    referencedPostIds: post.referencedPostIds ?? [],
    quotedContent: quoted,
    metrics: post.metrics ?? null,
    postedAt: post.postedAt,
  };
}

/**
 * A successful fetch, in one transaction: cache the posts, then move the
 * shared cursor and release the lock. The cursor only moves while this
 * worker still holds the lock; a worker whose lock expired caches its posts
 * (harmless, they're keyed by ID) but leaves the cursor to the new holder.
 */
export async function completeFetch(
  platformUserId: string,
  token: string,
  posts: NormalizedCandidatePost[],
  cursor: XScanCursor | null,
): Promise<{ cursorMoved: boolean }> {
  const release = db
    .update(xAccountsTable)
    .set({
      cursor,
      lastFetchedAt: sql`now()`,
      lastFetchStatus: "ok",
      lastFetchError: null,
      fetchLockToken: null,
      fetchLockedUntil: null,
    })
    .where(
      and(eq(xAccountsTable.platformUserId, platformUserId), eq(xAccountsTable.fetchLockToken, token)),
    )
    .returning({ id: xAccountsTable.platformUserId });

  if (posts.length === 0) {
    return { cursorMoved: (await release).length > 0 };
  }
  const [, released] = await db.batch([
    db
      .insert(xPostsTable)
      .values(posts.map((post) => toCacheRow(post, platformUserId)))
      .onConflictDoUpdate({
        target: xPostsTable.platformPostId,
        // Metrics keep growing; text can be edited; a later read may carry the quote
        set: {
          content: sql`excluded."content"`,
          metrics: sql`excluded."metrics"`,
          quotedContent: sql`coalesce(excluded."quotedContent", ${xPostsTable.quotedContent})`,
        },
      }),
    release,
  ]);
  return { cursorMoved: released.length > 0 };
}

/** A failed fetch: record it and release the lock; the cursor stays where it was. */
export async function failFetch(platformUserId: string, token: string, error: string): Promise<void> {
  await db
    .update(xAccountsTable)
    .set({
      lastFetchStatus: "failed",
      lastFetchError: error.slice(0, 500),
      fetchLockToken: null,
      fetchLockedUntil: null,
    })
    .where(
      and(eq(xAccountsTable.platformUserId, platformUserId), eq(xAccountsTable.fetchLockToken, token)),
    );
}

/**
 * Cached posts by these authors, posted after `postedAfter`, that this
 * profile hasn't been delivered yet (no scout_candidates row, scored or
 * rejected). Newest first. Profile-scoped: only the profile's own rows decide.
 */
export async function getUndeliveredCachedPosts(
  profileId: string,
  authorPlatformUserIds: string[],
  { postedAfter, limit }: { postedAfter: Date; limit: number },
): Promise<XPost[]> {
  if (authorPlatformUserIds.length === 0 || limit <= 0) return [];
  return db
    .select()
    .from(xPostsTable)
    .where(
      and(
        inArray(xPostsTable.authorPlatformUserId, authorPlatformUserIds),
        gte(xPostsTable.postedAt, postedAfter),
        notExists(
          db
            .select({ one: sql`1` })
            .from(scoutCandidatesTable)
            .where(
              and(
                eq(scoutCandidatesTable.profileId, profileId),
                eq(scoutCandidatesTable.platform, "x"),
                eq(scoutCandidatesTable.platformPostId, xPostsTable.platformPostId),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(xPostsTable.postedAt))
    .limit(limit);
}
