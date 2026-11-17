import "server-only";

import { saveAccountSnapshot } from "@/db/queries/growth";
import { countPostsBySocialAccount, savePosts } from "@/db/queries/posts";
import { getProfileById, updateProfileXHandle } from "@/db/queries/profiles";
import {
  linkCsvSocialAccount,
  markSocialAccountSynced,
  upsertSocialAccount,
} from "@/db/queries/socialAccounts";
import type { SocialAccount } from "@/db/schema";
import { getXUserPosts, getXUserWithCounts } from "@/lib/x/client";

// Every post read is billed by X; enough history for a first Brain test
const SYNC_POST_LIMIT = 100;

export type SyncXAccountResult =
  | { status: "no_handle" }
  | { status: "not_found"; handle: string }
  | { status: "synced"; account: SocialAccount; postCount: number };

/**
 * profile.xHandle → X user → recent posts → social_accounts + posts.
 * Safe to run repeatedly: both writes are upserts on unique keys.
 */
export async function syncXAccount(
  profileId: string,
): Promise<SyncXAccountResult> {
  const profile = await getProfileById(profileId);
  if (!profile?.xHandle) return { status: "no_handle" };

  const found = await getXUserWithCounts(profile.xHandle);
  if (!found) return { status: "not_found", handle: profile.xHandle };
  const xUser = found.profile;

  await linkCsvSocialAccount(profileId, "x", xUser);
  const account = await upsertSocialAccount(profileId, "x", xUser);
  const posts = await getXUserPosts(xUser.platformUserId, xUser.handle, {
    limit: SYNC_POST_LIMIT,
  });
  await savePosts(account.id, posts);
  await markSocialAccountSynced(account.id);
  // Day 33: the follower count came with the same lookup (no extra cost)
  await saveAccountSnapshot(profileId, account.id, found.counts);

  // Store X's canonical casing so the profile and account always match
  if (profile.xHandle !== xUser.handle) {
    await updateProfileXHandle(profileId, xUser.handle);
  }

  return {
    status: "synced",
    account,
    postCount: await countPostsBySocialAccount(account.id),
  };
}
