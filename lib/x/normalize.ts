import type { PostPrivateMetrics } from "@/db/schema";
import { withQuotedPost } from "@/lib/posts/quotedPost";
import type {
  NormalizedCandidatePost,
  NormalizedPost,
  NormalizedProfile,
  NormalizedProfileCounts,
  PostKind,
} from "@/lib/posts/types";

import type {
  XApiTweet,
  XApiUser,
} from "./types";

export function normalizeXUser(user: XApiUser): NormalizedProfile {
  return {
    platformUserId: user.id,
    handle: user.username,
    displayName: user.name || null,
    // The default image is a 48px thumbnail; this suffix is the larger variant
    avatarUrl: user.profile_image_url?.replace("_normal.", "_400x400.") ?? null,
  };
}

/** Public counts; null where X didn't return one (never a made-up zero) */
export function normalizeXUserCounts(user: XApiUser): NormalizedProfileCounts {
  return {
    followers: user.public_metrics?.followers_count ?? null,
    following: user.public_metrics?.following_count ?? null,
    postCount: user.public_metrics?.tweet_count ?? null,
  };
}

export function normalizeXPost(tweet: XApiTweet, handle: string): NormalizedPost {
  const kind = tweetKind(tweet);
  return {
    platformPostId: tweet.id,
    content: tweet.note_tweet?.text ?? tweet.text,
    url: `https://x.com/${handle}/status/${tweet.id}`,
    publishedAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
    metrics: {
      likes: tweet.public_metrics?.like_count ?? 0,
      replies: tweet.public_metrics?.reply_count ?? 0,
      reposts:
        (tweet.public_metrics?.retweet_count ?? 0) +
        (tweet.public_metrics?.quote_count ?? 0),
      impressions: tweet.public_metrics?.impression_count,
      ...(tweet.public_metrics && { quotes: tweet.public_metrics.quote_count }),
      ...(tweet.public_metrics?.bookmark_count !== undefined && { bookmarks: tweet.public_metrics.bookmark_count }),
    },
    kind: kind === "repost" ? undefined : kind,
    replyToPostId: tweet.referenced_tweets?.find((ref) => ref.type === "replied_to")?.id ?? null,
    metricsSource: "x_api",
    metricsFetchedAt: new Date(),
  };
}

/**
 * X's private metrics for the user's own post (OAuth only). Null when X
 * returned none, e.g. the post is older than 30 days. A missing field stays
 * missing: never a made-up zero.
 */
export function normalizeXPrivateMetrics(tweet: XApiTweet): PostPrivateMetrics | null {
  const priv = tweet.non_public_metrics;
  const organic = tweet.organic_metrics;
  if (!priv && !organic) return null;
  const metrics: PostPrivateMetrics = {};
  const impressions = priv?.impression_count ?? organic?.impression_count;
  const profileClicks = priv?.user_profile_clicks ?? organic?.user_profile_clicks;
  const urlClicks = priv?.url_link_clicks ?? organic?.url_link_clicks;
  if (impressions !== undefined) metrics.impressions = impressions;
  if (priv?.engagements !== undefined) metrics.engagements = priv.engagements;
  if (profileClicks !== undefined) metrics.profileClicks = profileClicks;
  if (urlClicks !== undefined) metrics.urlClicks = urlClicks;
  return Object.keys(metrics).length ? metrics : null;
}

function tweetKind(tweet: XApiTweet): PostKind {
  const types = new Set(tweet.referenced_tweets?.map((ref) => ref.type));
  if (types.has("retweeted")) return "repost";
  if (types.has("replied_to")) return "reply";
  if (types.has("quoted")) return "quote";
  return "post";
}

/**
 * `included` holds the referenced posts X expanded in the same response. A
 * quote's quoted text goes into its content, so scoring, replies and the feed
 * all see what the author reacted to. A quote whose quoted post X didn't
 * return (deleted, protected, or not requested) is marked as missing it.
 */
export function normalizeXCandidatePost(
  tweet: XApiTweet,
  author: { platformUserId: string; handle: string },
  included: Map<string, XApiTweet> = new Map(),
): NormalizedCandidatePost {
  const post = normalizeXPost(tweet, author.handle);
  const kind = tweetKind(tweet);
  const quotedId = tweet.referenced_tweets?.find((ref) => ref.type === "quoted")?.id;
  const quoted = quotedId ? included.get(quotedId) : undefined;
  const quotedText = quoted && (quoted.note_tweet?.text ?? quoted.text);

  return {
    platform: "x",
    platformPostId: post.platformPostId,
    authorPlatformUserId: author.platformUserId,
    authorHandle: author.handle,
    content: quotedText ? withQuotedPost(post.content, quotedText) : post.content,
    url: post.url,
    postedAt: post.publishedAt,
    kind,
    ...(kind === "quote" && { quotedPostIncluded: Boolean(quotedText) }),
    referencedPostIds: tweet.referenced_tweets?.map((ref) => ref.id) ?? [],
    metrics: post.metrics,
  };
}
