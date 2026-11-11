import { withQuotedPost } from "@/lib/posts/quotedPost";
import type {
  NormalizedCandidatePost,
  NormalizedPost,
  NormalizedProfile,
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

export function normalizeXPost(tweet: XApiTweet, handle: string): NormalizedPost {
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
    },
  };
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
