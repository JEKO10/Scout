import "server-only";

import { recordXUsage, reserveXRequest } from "@/db/queries/xApiUsage";
import type {
  NormalizedCandidatePost,
  NormalizedPost,
  NormalizedProfile,
} from "@/lib/posts/types";
import { getScoutLimits } from "@/lib/scout/testLimits";
import type { XRunUsage } from "@/lib/scout/types";

import {
  normalizeXCandidatePost,
  normalizeXPost,
  normalizeXUser,
} from "./normalize";
import type {
  XApiTimelineResponse,
  XApiTweet,
  XApiUserResponse,
} from "./types";

const X_API_BASE_URL = "https://api.x.com/2";
const REQUEST_TIMEOUT_MS = 15_000;
/** Waiting longer than this for a rate limit would hold the whole scan */
const MAX_RETRY_WAIT_MS = 10_000;
const RETRY_DELAY_MS = 1_000;

export class XApiRequestError extends Error {
  constructor(
    message: string,
    /** 0 when the request never got a response (network error, timeout) */
    readonly status: number,
    readonly rateLimitResetAt?: Date,
  ) {
    super(message);
    this.name = "XApiRequestError";
  }
}

/** Today's request budget is used up; nothing was sent. */
export class XApiBudgetError extends Error {
  constructor(limit: number) {
    super(`Daily X API request limit reached (${limit}). Scout stops calling X until tomorrow (UTC).`);
    this.name = "XApiBudgetError";
  }
}

/** Per-run counters a caller can pass in; the daily totals live in the database. */
export type XRequestStats = Omit<XRunUsage, "stoppedReason">;

async function toRequestError(res: Response): Promise<XApiRequestError> {
  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const retryAfter = res.headers.get("retry-after");
    const resetAt = retryAfter
      ? new Date(Date.now() + Number(retryAfter) * 1000)
      : reset
        ? new Date(Number(reset) * 1000)
        : undefined;
    return new XApiRequestError("X API rate limit reached.", 429, resetAt);
  }
  const body = await res.json().catch(() => null);
  const detail = body?.detail ?? body?.title ?? res.statusText;
  return new XApiRequestError(`X API error (${res.status}): ${detail}`, res.status);
}

/**
 * How long to wait before retrying, or null when retrying can't help: bad
 * token, no credits, no access, bad request, or a long rate-limit window.
 */
function retryDelay(error: XApiRequestError): number | null {
  if (error.status === 429) {
    if (!error.rateLimitResetAt) return null;
    const wait = error.rateLimitResetAt.getTime() - Date.now();
    return wait <= MAX_RETRY_WAIT_MS ? Math.max(wait, 0) : null;
  }
  if (error.status === 0 || error.status >= 500) return RETRY_DELAY_MS;
  return null;
}

/**
 * The only place Scout talks to X. Every attempt, retries included, is
 * reserved in the daily budget before it is sent and counted even if it fails.
 */
async function xFetch<T>(
  path: string,
  params: Record<string, string | undefined> = {},
  stats?: XRequestStats,
): Promise<T> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN is not set.");
  const { maxXRetries, maxXRequestsPerDay } = getScoutLimits();

  const url = new URL(`${X_API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  for (let attempt = 0; ; attempt++) {
    const retry = attempt > 0;
    if (!(await reserveXRequest(maxXRequestsPerDay, { retry }))) {
      throw new XApiBudgetError(maxXRequestsPerDay ?? 0);
    }
    if (stats) {
      stats.requests++;
      if (retry) stats.retried++;
    }

    let error: XApiRequestError;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as T;
      error = await toRequestError(res);
    } catch (cause) {
      error = new XApiRequestError(
        `X API unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
      );
    }

    await recordXUsage({ failedRequests: 1 });
    if (stats) stats.failed++;
    const wait = retryDelay(error);
    if (wait === null || attempt >= maxXRetries) throw error;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Looks up a public X user. Returns null when the account doesn't exist or is
 * suspended, which X reports as 200 with `errors` and no `data`.
 */
export async function getXUserByHandle(
  handle: string,
): Promise<NormalizedProfile | null> {
  const body = await xFetch<XApiUserResponse>(
    `/users/by/username/${encodeURIComponent(handle)}`,
    { "user.fields": "profile_image_url" },
  );

  return body.data ? normalizeXUser(body.data) : null;
}

export type XTimelineQuery = {
  /** One page, never paginated: every post read is billed */
  limit: number;
  /** Only posts with a larger ID */
  sinceId?: string;
  /** Only posts with a smaller ID */
  untilId?: string;
  /** Only posts after this moment; not sent together with sinceId */
  startTime?: Date;
  excludeReplies?: boolean;
  /**
   * Also return the posts these posts reference, in the same request. With
   * replies excluded that means only what quotes quote; never parent posts.
   */
  includeReferenced?: boolean;
};

/**
 * One page of a user's posts, newest first, never reposts. `hasMore` means X
 * has more matching posts than this page holds. `included` holds expanded
 * referenced posts by ID.
 */
async function fetchUserTweets(
  platformUserId: string,
  query: XTimelineQuery,
  stats?: XRequestStats,
): Promise<{ tweets: XApiTweet[]; included: Map<string, XApiTweet>; hasMore: boolean }> {
  const body = await xFetch<XApiTimelineResponse>(
    `/users/${encodeURIComponent(platformUserId)}/tweets`,
    {
      // X requires 5–100 results per page
      max_results: String(Math.min(Math.max(query.limit, 5), 100)),
      exclude: query.excludeReplies ? "retweets,replies" : "retweets",
      "tweet.fields": "created_at,public_metrics,note_tweet,referenced_tweets",
      since_id: query.sinceId,
      until_id: query.untilId,
      start_time: query.sinceId ? undefined : query.startTime?.toISOString(),
      expansions: query.includeReferenced ? "referenced_tweets.id" : undefined,
    },
    stats,
  );

  const tweets = (body.data ?? []).slice(0, query.limit);
  const included = body.includes?.tweets ?? [];
  // Expanded posts count too: X likely bills them as reads
  const returned = tweets.length + included.length;
  if (stats) stats.postsReturned += returned;
  await recordXUsage({ postsReturned: returned });
  return {
    tweets,
    included: new Map(included.map((tweet) => [tweet.id, tweet])),
    hasMore: Boolean(body.meta?.next_token) || (body.data?.length ?? 0) > query.limit,
  };
}

/** The user's own posts, for the Scout Brain. */
export async function getXUserPosts(
  platformUserId: string,
  handle: string,
  { limit = 100 }: { limit?: number } = {},
): Promise<NormalizedPost[]> {
  const { tweets } = await fetchUserTweets(platformUserId, { limit });
  return tweets.map((tweet) => normalizeXPost(tweet, handle));
}

/** A watched account's posts, for the scan pipeline. */
export async function getXUserCandidatePosts(
  author: { platformUserId: string; handle: string },
  query: XTimelineQuery,
  stats?: XRequestStats,
): Promise<{ posts: NormalizedCandidatePost[]; hasMore: boolean }> {
  const { tweets, included, hasMore } = await fetchUserTweets(
    author.platformUserId,
    query,
    stats,
  );
  return {
    posts: tweets.map((tweet) => normalizeXCandidatePost(tweet, author, included)),
    hasMore,
  };
}
