// Day 38 Approval Inbox: the shapes shared by the assembler, the service,
// the schema and the cards. No server code here.

export const INBOX_ITEM_TYPES = ["post", "reply", "conversation", "lead", "recommendation", "reminder", "publish"] as const;
export type InboxItemType = (typeof INBOX_ITEM_TYPES)[number];

/** What the user decided. "snoozed" is the only one that isn't final. */
export const INBOX_DECISIONS = ["approved", "declined", "saved", "dismissed", "accepted", "done", "snoozed"] as const;
export type InboxDecision = (typeof INBOX_DECISIONS)[number];

/** The optional "Why wasn't this useful?" answers */
export const DECLINE_REASONS = ["not_relevant", "wrong_tone", "too_promotional", "already_handled"] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export const DECLINE_LABEL: Record<DeclineReason, string> = {
  not_relevant: "Not relevant",
  wrong_tone: "Wrong tone",
  too_promotional: "Too promotional",
  already_handled: "Already handled",
};

/** The four one-click AI edits */
export const QUICK_EDITS = ["shorter", "natural", "hook", "less_promo"] as const;
export type QuickEdit = (typeof QUICK_EDITS)[number];

export const QUICK_EDIT_LABEL: Record<QuickEdit, string> = {
  shorter: "Shorter",
  natural: "More natural",
  hook: "Stronger hook",
  less_promo: "Less promotional",
};

/** What a revision row was made by */
export type RevisionKind = "original" | "ai_edit" | "regenerate";

/**
 * Proposed daily caps for what the Inbox shows (free: it only organizes
 * stored data). More cards aren't more value: when nothing is good enough,
 * fewer show.
 */
export const INBOX_CAPS = {
  /** Conversations, prepared reply or not */
  conversations: 3,
  /** Of those, with a reply ready */
  replies: 2,
  posts: 1,
  leads: 2,
  reminders: 3,
  recommendations: 1,
} as const;

/** Older than this, an item no longer shows (it's kept where it came from) */
export const INBOX_MAX_AGE_HOURS = {
  conversation: 48,
  lead: 72,
  /** Scout-prepared drafts nobody reviewed are archived after this */
  post: 7 * 24,
  reminder: 3 * 24,
  followUp: 14 * 24,
} as const;

/** Above this score and this fresh, a conversation is urgent (top of the Inbox) */
export const URGENT = { score: 80, hours: 12 } as const;

/** AI revisions (edits + regenerations) of one item */
export const MAX_REVISIONS_PER_ITEM = 6;
/** One AI revision at a time */
export const MIN_SECONDS_BETWEEN_REVISIONS = 3;

/** One card. `key` identifies the underlying event: one card per event. */
export type InboxItem = {
  key: string;
  type: InboxItemType;
  /** Ordering bucket: lower first */
  rank: number;
  /** Within a bucket: higher first */
  score: number;
  /** For sorting ties: newer first */
  at: string;
  /** "Post ready", "Reply ready"… */
  label: string;
  /** The prepared result (draft, reply) or what the card is about */
  text: string;
  /** One sentence: why Scout put it here */
  why: string;
  /** Reply / conversation / lead: the post it's about */
  context?: { author: string | null; text: string; url: string | null };
  /** The Scout page with the details (built by Scout, never from AI output) */
  href?: string;
  /** Opened in a new tab (the conversation on X) */
  externalUrl?: string | null;
  /** Post / reply: the X post ID to reply to (X's own composer) */
  replyToPostId?: string | null;
  /** Small line under the label: "25 minutes ago", "Growth experiment" (formatted on the server) */
  meta?: string;
  /** Recommendation: its name ("Short vs. standard posts") */
  headline?: string;
  /** Recommendation: what the user does once it starts */
  steps?: string[];
  /**
   * Reminder asking for work Scout can do itself (a growth-plan "post 1 reply
   * and 1 baseline post"): what one click prepares. Only what isn't ready yet,
   * and a reply only when there's a conversation worth answering.
   */
  prepare?: ("post" | "reply")[];
  /** Day 40: an approved post on its way to X */
  publication?: PublicationCard;
};

/** What a "Ready to publish" card needs; formatted on the server, never a token */
export type PublicationCard = {
  id: string;
  draftId: string | null;
  status: "approved" | "scheduled" | "publishing" | "published" | "failed" | "unknown" | "cancelled";
  hasUrl: boolean;
  /** "Scheduled for Fri, Nov 21, 10:30" */
  scheduledLabel: string | null;
  error: string | null;
  /** Connected with publishing allowed */
  canPublish: boolean;
  /** The plan publishes from Scout at all */
  planAllows: boolean;
  postUrl: string | null;
  /** The schedule form's defaults, in the user's time zone */
  defaultDate: string;
  defaultTime: string;
  timeZone: string;
};

export type InboxSummary = {
  total: number;
  /** "2 conversations worth joining", in display order */
  parts: string[];
};

/** Learned from what the user did in the Inbox; shown and resettable */
export type InboxPreferences = {
  /** Drafts come out short */
  shorter: boolean;
  /** Promotional drafts are avoided */
  lessPromotional: boolean;
  /** Stay closer to their own voice (declined for tone) */
  closerToVoice: boolean;
  /** Topics the user kept declining as not relevant */
  avoidTopics: string[];
  /** A content goal the user keeps approving */
  favoredGoal: string | null;
  /** Plain sentences: what Scout learned and from what */
  evidence: string[];
};

export const NO_PREFERENCES: InboxPreferences = {
  shorter: false,
  lessPromotional: false,
  closerToVoice: false,
  avoidTopics: [],
  favoredGoal: null,
  evidence: [],
};
