import "server-only";

import { countPostsBySocialAccount, savePosts } from "@/db/queries/posts";
import { getProfileById, updateProfileXHandle } from "@/db/queries/profiles";
import {
  markSocialAccountSynced,
  upsertSocialAccount,
} from "@/db/queries/socialAccounts";
import type { SocialAccount } from "@/db/schema";
import { getXUserByHandle, getXUserPosts } from "@/lib/x/client";

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

  const xUser = await getXUserByHandle(profile.xHandle);
  if (!xUser) return { status: "not_found", handle: profile.xHandle };

  const account = await upsertSocialAccount(profileId, "x", xUser);
  const posts = await getXUserPosts(xUser.platformUserId, xUser.handle, {
    limit: SYNC_POST_LIMIT,
  });
  await savePosts(account.id, posts);
  await markSocialAccountSynced(account.id);

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
