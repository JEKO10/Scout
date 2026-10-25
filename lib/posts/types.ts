// ---------------------------------------------------------------------------
// Scout's source-agnostic formats. Every post source (X API, imports, other
// providers) converts its data into these; nothing downstream knows where
// a post came from. Field names match the social_accounts / posts columns.
// ---------------------------------------------------------------------------

export type NormalizedProfile = {
  platformUserId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type NormalizedPost = {
  platformPostId: string;
  content: string;
  url: string;
  publishedAt: Date;
  metrics: {
    likes: number;
    replies: number;
    reposts: number;
    impressions?: number;
  };
};

export type PostKind = "post" | "reply" | "quote" | "repost";

/**
 * A post by someone on the watchlist, as every post source delivers it.
 * From here on nothing in Scout knows what the provider's response looked like.
 */
export type NormalizedCandidatePost = {
  platform: "x";
  platformPostId: string;
  /** Null when the source only knows the handle (e.g. imported exports) */
  authorPlatformUserId: string | null;
  authorHandle: string;
  content: string;
  url: string;
  postedAt: Date;
  kind: PostKind;
  metrics?: {
    likes?: number;
    replies?: number;
    reposts?: number;
    impressions?: number;
  };
};
