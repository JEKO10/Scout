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
]);

/** The launch funnel, in order, for the internal dashboard */
export const FUNNEL: AnalyticsEvent[] = [
  "landing_view",
  "start_free_click",
  "signup_completed",
  "onboarding_completed",
  "first_scan_completed",
  "first_reply_generated",
  "first_reply_on_x",
  "pricing_view",
  "checkout_started",
  "subscription_activated",
  "waitlist_joined",
];
