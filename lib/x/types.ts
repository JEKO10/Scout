// ---------------------------------------------------------------------------
// Raw X API v2 shapes. Only lib/x should ever touch these.
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
};

export type XApiTimelineResponse = {
  data?: XApiTweet[];
  meta?: { result_count: number; next_token?: string };
  errors?: XApiError[];
};

// ---------------------------------------------------------------------------
// Scout's internal format. The rest of the app only sees these.
// Field names match the social_accounts / posts columns.
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
