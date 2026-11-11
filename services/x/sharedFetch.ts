import "server-only";

import { randomUUID } from "node:crypto";

import {
  acquireFetchLock,
  completeFetch,
  failFetch,
  getFetchState,
  getOrCreateXAccount,
} from "@/db/queries/xCache";
import type { XRunUsage } from "@/lib/scout/types";
import { xApiSource } from "@/services/post-sources/xApi";

/** A shared fetch this recent is reused instead of asking X again */
export const SHARED_FETCH_FRESH_MINUTES = 15;
/**
 * Longer than one fetch can ever take: two 15 s attempts, up to 10 s waiting
 * on a rate limit, the cache write. After this a crashed worker's lock can be
 * taken over; a slow worker that loses it can't move the cursor (token check).
 */
const LOCK_SECONDS = 120;
/** Default wait for another worker's fetch; the scheduler passes 0 and moves on */
const DEFAULT_LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 300;

export type SharedFetchResult =
  /** The cache was fresh; no X request */
  | { status: "fresh" }
  /** Another worker was fetching; this one waited and uses its result */
  | { status: "waited" }
  /** Another worker still holds the lock after the wait; the cache is used as is */
  | { status: "busy" }
  /** This worker fetched; `posts` were cached */
  | { status: "fetched"; posts: number; cursorMoved: boolean };

/**
 * Makes sure the shared cache holds an account's recent posts, asking X only
 * when nobody fetched it in the last SHARED_FETCH_FRESH_MINUTES. Coordinated
 * through the database, so separate serverless instances never fetch the same
 * account at once. On failure the lock is released, the error recorded and
 * the shared cursor left where it was; the error is rethrown for the caller.
 */
export async function ensureFreshPosts(
  account: { platformUserId: string; handle: string },
  {
    firstLimit,
    nextLimit,
    notBefore,
    usage,
    lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  }: {
    /** Page size for an account never fetched before */
    firstLimit: number;
    nextLimit: number;
    /** Oldest post worth fetching on a first read */
    notBefore: Date;
    /** The triggering run's X counters: real requests count once, here */
    usage?: Omit<XRunUsage, "stoppedReason">;
    /** How long to wait for another worker's fetch; 0: report "busy" at once */
    lockWaitMs?: number;
  },
): Promise<SharedFetchResult> {
  await getOrCreateXAccount(account.platformUserId, account.handle);
  const token = randomUUID();
  const lockOptions = { freshMinutes: SHARED_FETCH_FRESH_MINUTES, lockSeconds: LOCK_SECONDS };

  let locked = await acquireFetchLock(account.platformUserId, token, lockOptions);
  let waited = false;
  const deadline = Date.now() + lockWaitMs;
  while (!locked) {
    const state = await getFetchState(account.platformUserId, SHARED_FETCH_FRESH_MINUTES);
    if (state.fresh) return { status: waited ? "waited" : "fresh" };
    // Not fresh and not locked: the holder failed or its lock expired
    if (!state.locked) {
      locked = await acquireFetchLock(account.platformUserId, token, lockOptions);
      if (locked) break;
    }
    if (Date.now() > deadline) return { status: "busy" };
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }

  try {
    const { posts, nextCursor } = await xApiSource.fetchPosts({
      profileId: "shared", // unused by the X source: X posts belong to no profile
      account: {
        platformUserId: account.platformUserId,
        handle: account.handle,
        xCursor: locked.cursor,
      },
      since: null,
      limit: locked.cursor ? nextLimit : firstLimit,
      notBefore,
      usage,
    });
    const { cursorMoved } = await completeFetch(
      account.platformUserId,
      token,
      posts,
      nextCursor ?? null,
    );
    return { status: "fetched", posts: posts.length, cursorMoved };
  } catch (error) {
    await failFetch(account.platformUserId, token, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
