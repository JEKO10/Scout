// ---------------------------------------------------------------------------
// Raw X API v2 shapes. Only lib/x should ever touch these; normalize.ts
// converts them to the source-agnostic types in lib/posts/types.ts.
// ---------------------------------------------------------------------------

export type XApiError = {
  title: string;
  detail?: string;
  type?: string;
  resource_type?: string;
  value?: string;
};

export type XApiUser = {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  /** Day 35 peers: requested with user.fields (same request, same price) */
  description?: string;
  created_at?: string;
  /** Requested with user.fields=public_metrics (same request, same price) */
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
  };
};

export type XApiUserResponse = {
  data?: XApiUser;
  errors?: XApiError[];
};

export type XApiTweet = {
  id: string;
  text: string;
  /** Requested with expansions=author_id (search results) */
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
    impression_count?: number;
    bookmark_count?: number;
  };
  /** X OAuth, the user's own posts from the last 30 days only */
  non_public_metrics?: {
    impression_count?: number;
    url_link_clicks?: number;
    user_profile_clicks?: number;
    engagements?: number;
  };
  /** X OAuth, the user's own posts: organic (unpromoted) counts */
  organic_metrics?: {
    impression_count?: number;
    url_link_clicks?: number;
    user_profile_clicks?: number;
  };
  // Posts longer than 280 characters are truncated in `text`
  note_tweet?: { text: string };
  referenced_tweets?: {
    type: "replied_to" | "quoted" | "retweeted";
    id: string;
  }[];
};

export type XApiTimelineResponse = {
  data?: XApiTweet[];
  /** Expanded referenced posts, e.g. what a quote quotes */
  includes?: { tweets?: XApiTweet[] };
  meta?: { result_count: number; next_token?: string };
  errors?: XApiError[];
};
