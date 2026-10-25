import "server-only";

import { getImportedPostsByAuthor } from "@/db/queries/importedPosts";

import type { PostSource } from "./types";

/**
 * Posts the user imported from exports. Works without any API credits.
 *
 * `since` means "imported since": an export imported after the last scan is
 * new to Scout even if its posts are a few days old. Posts that are too old
 * are dropped later by the candidate filters.
 */
export const importedSource: PostSource = {
  id: "import",

  async fetchPosts({ profileId, account, since, limit }) {
    const posts = await getImportedPostsByAuthor(profileId, account.handle, {
      importedAfter: since,
      limit,
    });

    return posts.map((post) => ({
      platform: "x" as const,
      platformPostId: post.platformPostId,
      authorPlatformUserId: null,
      authorHandle: post.authorHandle,
      content: post.content,
      url: post.url,
      postedAt: post.postedAt,
      kind: post.kind,
      metrics: post.metrics ?? undefined,
    }));
  },
};
