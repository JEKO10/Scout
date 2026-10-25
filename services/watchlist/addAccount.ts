import "server-only";

import {
  countWatchlist,
  findWatchlistAccountByHandle,
  insertWatchlistAccount,
} from "@/db/queries/watchlist";
import type { WatchlistAccount } from "@/db/schema";
import type { NormalizedProfile } from "@/lib/posts/types";
import { PostSourceUnavailableError } from "@/services/post-sources/types";
import { xApiSource } from "@/services/post-sources/xApi";

export const WATCHLIST_LIMIT = 20;

const UNVERIFIED_PREFIX = "unverified:";

/**
 * Accounts added while the source can't verify them (e.g. X credits are
 * out) get a placeholder platformUserId. Day 8 resolves them before scanning.
 */
export function isUnverified(account: Pick<WatchlistAccount, "platformUserId">) {
  return account.platformUserId.startsWith(UNVERIFIED_PREFIX);
}

export type AddWatchlistAccountResult =
  | { status: "added"; account: WatchlistAccount; verified: boolean }
  | { status: "duplicate"; handle: string }
  | { status: "not_found"; handle: string }
  | { status: "limit_reached" };

export async function addWatchlistAccount(
  profileId: string,
  handle: string,
): Promise<AddWatchlistAccountResult> {
  if ((await countWatchlist(profileId)) >= WATCHLIST_LIMIT) {
    return { status: "limit_reached" };
  }

  const existing = await findWatchlistAccountByHandle(profileId, "x", handle);
  if (existing) return { status: "duplicate", handle: existing.handle };

  let profile: NormalizedProfile | null;
  let verified = true;
  try {
    profile = await xApiSource.resolveAccount(handle);
  } catch (error) {
    if (!(error instanceof PostSourceUnavailableError)) throw error;
    // The source is down, not the account: keep the handle, verify later
    verified = false;
    profile = {
      platformUserId: `${UNVERIFIED_PREFIX}${handle.toLowerCase()}`,
      handle,
      displayName: null,
      avatarUrl: null,
    };
  }
  if (!profile) return { status: "not_found", handle };

  // The UNIQUE(profileId, platform, platformUserId) constraint is the final
  // guard, e.g. when the same X account was saved under its old handle
  const account = await insertWatchlistAccount(profileId, "x", profile);
  if (!account) return { status: "duplicate", handle: profile.handle };

  return { status: "added", account, verified };
}
