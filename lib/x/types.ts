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
};

export type XApiUserResponse = {
  data?: XApiUser;
  errors?: XApiError[];
};

export type XApiTweet = {
  id: string;
  text: string;
  created_at?: string;
  public_metrics?: {
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
    impression_count?: number;
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
  meta?: { result_count: number; next_token?: string };
  errors?: XApiError[];
};
