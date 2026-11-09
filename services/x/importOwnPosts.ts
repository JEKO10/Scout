import "server-only";

import { savePosts } from "@/db/queries/posts";
import { getProfileById, updateProfileXHandle } from "@/db/queries/profiles";
import {
  csvPlatformUserId,
  getSocialAccountByHandle,
  markSocialAccountSynced,
  upsertSocialAccount,
} from "@/db/queries/socialAccounts";
import { parseTwExtractCsv } from "@/lib/import/twExtractCsv";
import type { NormalizedCandidatePost } from "@/lib/posts/types";

export type ImportOwnPostsResult =
  | { status: "no_posts" }
  | { status: "wrong_author"; handle: string; found: string }
  | { status: "imported"; handle: string; postCount: number };

/** The export's most common author: exports also list retweets of other people. */
function mainAuthor(posts: NormalizedCandidatePost[]): string {
  const counts = new Map<string, { handle: string; count: number }>();
  for (const post of posts) {
    const key = post.authorHandle.toLowerCase();
    const entry = counts.get(key) ?? { handle: post.authorHandle, count: 0 };
    counts.set(key, { ...entry, count: entry.count + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0].handle;
}

/**
 * The user's own posts from a CSV export, into `posts` where the Scout Brain
 * reads them. Different from watchlist imports, which hold other people's
 * posts. Works without X credits. Throws if the CSV can't be parsed.
 */
export async function importOwnPosts(
  profileId: string,
  csv: string,
): Promise<ImportOwnPostsResult> {
  const parsed = parseTwExtractCsv(csv);
  if (parsed.length === 0) return { status: "no_posts" };

  const profile = await getProfileById(profileId);
  const handle = profile?.xHandle ?? mainAuthor(parsed);
  const own = parsed.filter(
    (post) =>
      post.authorHandle.toLowerCase() === handle.toLowerCase() &&
      post.kind !== "repost",
  );
  if (own.length === 0) {
    return { status: "wrong_author", handle, found: mainAuthor(parsed) };
  }

  const account =
    (await getSocialAccountByHandle(profileId, "x", handle)) ??
    (await upsertSocialAccount(profileId, "x", {
      // A later X sync replaces this with the real ID (linkCsvSocialAccount)
      platformUserId: csvPlatformUserId(handle),
      handle: own[0].authorHandle,
      displayName: null,
      avatarUrl: null,
    }));

  await savePosts(
    account.id,
    own.map((post) => ({
      platformPostId: post.platformPostId,
      content: post.content,
      url: post.url,
      publishedAt: post.postedAt,
      metrics: {
        likes: post.metrics?.likes ?? 0,
        replies: post.metrics?.replies ?? 0,
        reposts: post.metrics?.reposts ?? 0,
        impressions: post.metrics?.impressions,
      },
    })),
  );
  await markSocialAccountSynced(account.id);
  if (profile?.xHandle !== own[0].authorHandle) {
    await updateProfileXHandle(profileId, own[0].authorHandle);
  }

  return {
    status: "imported",
    handle: own[0].authorHandle,
    postCount: own.length,
  };
}
