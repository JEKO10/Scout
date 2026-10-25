import "server-only";

import type {
  NormalizedCandidatePost,
  NormalizedPost,
  NormalizedProfile,
} from "@/lib/posts/types";

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

export class XApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimitResetAt?: Date,
  ) {
    super(message);
    this.name = "XApiRequestError";
  }
}

async function xFetch<T>(
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN is not set.");

  const url = new URL(`${X_API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    throw new XApiRequestError(
      "X API rate limit reached.",
      429,
      reset ? new Date(Number(reset) * 1000) : undefined,
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail ?? body?.title ?? res.statusText;
    throw new XApiRequestError(`X API error: ${detail}`, res.status);
  }

  return res.json() as Promise<T>;
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

/**
 * A user's recent original posts, replies and quotes (no retweets), newest
 * first, following pagination until `limit` is reached. With `since`, only
 * posts after that moment are requested. Every post read is billed.
 */
async function fetchUserTweets(
  platformUserId: string,
  { limit, since }: { limit: number; since?: Date | null },
): Promise<XApiTweet[]> {
  const tweets: XApiTweet[] = [];
  let paginationToken: string | undefined;

  do {
    const remaining = limit - tweets.length;
    const body = await xFetch<XApiTimelineResponse>(
      `/users/${encodeURIComponent(platformUserId)}/tweets`,
      {
        // X requires 5–100 results per page
        max_results: String(Math.min(Math.max(remaining, 5), 100)),
        exclude: "retweets",
        "tweet.fields": "created_at,public_metrics,note_tweet,referenced_tweets",
        start_time: since?.toISOString(),
        pagination_token: paginationToken,
      },
    );

    tweets.push(...(body.data ?? []));
    paginationToken = body.meta?.next_token;
  } while (paginationToken && tweets.length < limit);

  return tweets.slice(0, limit);
}

/** The user's own posts, for the Scout Brain. */
export async function getXUserPosts(
  platformUserId: string,
  handle: string,
  { limit = 100 }: { limit?: number } = {},
): Promise<NormalizedPost[]> {
  const tweets = await fetchUserTweets(platformUserId, { limit });
  return tweets.map((tweet) => normalizeXPost(tweet, handle));
}

/** A watched account's posts, for the scan pipeline. */
export async function getXUserCandidatePosts(
  author: { platformUserId: string; handle: string },
  { limit, since }: { limit: number; since: Date | null },
): Promise<NormalizedCandidatePost[]> {
  const tweets = await fetchUserTweets(author.platformUserId, { limit, since });
  return tweets.map((tweet) => normalizeXCandidatePost(tweet, author));
}
