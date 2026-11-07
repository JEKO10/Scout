import "server-only";

import { getImportedPostsByAuthor } from "@/db/queries/importedPosts";

import type { PostSource } from "./types";

/** Safety cap per account and scan; far above any single export */
const IMPORT_SCAN_CAP = 1000;

/**
 * Posts the user imported from exports. Works without any API credits.
 *
 * `since` means "imported since": an export imported after the last scan is
 * new to Scout even if its posts are a few days old. Posts that are too old
 * are dropped later by the candidate filters.
 */
export const importedSource: PostSource = {
  id: "import",

  // `limit` exists to save API costs. Imports are free and the watermark is the
  // import time, so a capped scan would skip the rest of an export for good
  async fetchPosts({ profileId, account, since }) {
    const posts = await getImportedPostsByAuthor(profileId, account.handle, {
      importedAfter: since,
      limit: IMPORT_SCAN_CAP,
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
