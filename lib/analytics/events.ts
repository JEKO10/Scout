// Day 24 launch analytics: the only events Scout records. Names are fixed
// here so nothing else (and nothing a browser sends) can be stored.

/** Events a browser may report (public pages, no account needed) */
export const CLIENT_EVENTS = ["landing_view", "start_free_click", "pricing_view", "see_how_click"] as const;

/** Events recorded on the server, tied to the signed-in profile */
export const SERVER_EVENTS = [
  "signup_completed",
  "onboarding_completed",
  "first_scan_completed",
  "first_reply_generated",
  "first_reply_on_x",
  "checkout_started",
  "subscription_activated",
  "waitlist_joined",
  // Day 25
  "first_watchlist_added",
  "first_opportunity_viewed",
  "reply_on_x_clicked",
  "feedback_submitted",
  // Day 27 Lead Scout
  "lead_saved",
  "lead_reply_started",
  "lead_opened_on_x",
  // Day 29 Trend Scout
  "trend_viewed",
  "trend_conversation_opened",
  // Day 30
  "trend_saved",
  "trend_insight_generated",
  // Day 31 Content Studio
  "content_ideas_generated",
  "content_draft_created",
  "content_draft_edited",
  "content_reviewed",
  "content_copied",
  "content_opened_on_x",
  "content_publish_confirmed",
  // Day 32 Content Calendar
  "content_planned",
  "content_rescheduled",
  "content_marked_ready",
  "content_published_url_saved",
  "content_plan_missed",
] as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[number];
export type ServerEvent = (typeof SERVER_EVENTS)[number];
export type AnalyticsEvent = ClientEvent | ServerEvent;

/** Milestones: counted once per profile (the funnel), whatever happens later */
export const ONCE_EVENTS = new Set<AnalyticsEvent>([
  "signup_completed",
  "onboarding_completed",
  "first_scan_completed",
  "first_reply_generated",
  "first_reply_on_x",
  "waitlist_joined",
  "first_watchlist_added",
  "first_opportunity_viewed",
]);

/** The launch funnel, in order, for the internal dashboard */
export const FUNNEL: AnalyticsEvent[] = [
  "landing_view",
  "start_free_click",
  "signup_completed",
  "onboarding_completed",
  "first_watchlist_added",
  "first_scan_completed",
  "first_opportunity_viewed",
  "first_reply_generated",
  "first_reply_on_x",
  "reply_on_x_clicked",
  "feedback_submitted",
  "lead_saved",
  "lead_reply_started",
  "lead_opened_on_x",
  "trend_viewed",
  "trend_conversation_opened",
  "trend_saved",
  "trend_insight_generated",
  "content_ideas_generated",
  "content_draft_created",
  "content_reviewed",
  "content_opened_on_x",
  "content_publish_confirmed",
  "content_planned",
  "content_plan_missed",
  "pricing_view",
  "checkout_started",
  "subscription_activated",
  "waitlist_joined",
];
