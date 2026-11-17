// Day 33 Growth Intelligence: what each platform's numbers mean and which ones
// Scout can actually read. Platforms count differently (X "impressions" are
// views of a post; Instagram separates reach and views; LinkedIn has its own
// definitions), so numbers are never compared across platforms.

export const GROWTH_RANGES = [7, 30, 90] as const;
export type GrowthRange = (typeof GROWTH_RANGES)[number];

export type GrowthPlatform = "x" | "instagram" | "linkedin";

export type MetricKey =
  | "impressions"
  | "likes"
  | "replies"
  | "reposts"
  | "bookmarks"
  | "followers"
  | "profileVisits"
  | "linkClicks";

export type MetricCapability = { available: true; source: string } | { available: false; reason: string };

/**
 * X with Scout's current access: an app-only token (public data), no user
 * sign-in. Public post counts and follower counts are readable; private
 * analytics are not.
 */
export const X_CAPABILITIES: Record<MetricKey, MetricCapability> = {
  impressions: { available: true, source: "X public post metrics (impression_count)" },
  likes: { available: true, source: "X public post metrics" },
  replies: { available: true, source: "X public post metrics" },
  reposts: { available: true, source: "X public post metrics (reposts + quotes)" },
  bookmarks: { available: true, source: "X public post metrics, for posts read from now on" },
  followers: { available: true, source: "X public profile counts, one reading per sync or refresh" },
  profileVisits: {
    available: false,
    reason: "Needs X's private analytics, which require signing in with X (OAuth) and your permission. Scout doesn't have that access.",
  },
  linkClicks: {
    available: false,
    reason: "Needs X's private analytics, which require signing in with X (OAuth) and your permission. Scout doesn't have that access.",
  },
};

export const PLATFORM_CAPABILITIES: Record<GrowthPlatform, Partial<Record<MetricKey, MetricCapability>> | null> = {
  x: X_CAPABILITIES,
  // Not connected yet: their metrics will get their own definitions
  instagram: null,
  linkedin: null,
};

/** Engagement on X, the same everywhere in Scout: likes + replies + reposts (quotes included) */
export const X_ENGAGEMENT_DEFINITION = "likes + replies + reposts (quotes included)";
export const X_ENGAGEMENT_RATE_DEFINITION = "engagement ÷ impressions, only for posts X reported impressions for";

export const METRIC_LABEL: Record<MetricKey, string> = {
  impressions: "Impressions",
  likes: "Likes",
  replies: "Replies",
  reposts: "Reposts",
  bookmarks: "Bookmarks",
  followers: "Followers",
  profileVisits: "Profile visits",
  linkClicks: "Link clicks",
};
