import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { EngagementDecision } from "../lib/ai/schemas/brainEval";
import type {
  StoredGoalBrain,
  StoredInterestBrain,
  StoredVoiceBrain,
} from "../lib/ai/schemas/scoutBrain";
import { PLAN_IDS, type UsageLimits } from "../lib/billing/plans";
import { REPLY_STYLES } from "../lib/replies/styles";
import type { LearningProfile } from "../lib/scout/learning";
import type { PrefilterReason } from "../lib/scout/prefilter";
import type { ReplyPreferences } from "../lib/scout/replyPreferences";
import { OPPORTUNITY_SENSITIVITIES } from "../lib/scout/sensitivity";
import type {
  CandidateFilterReason,
  OpportunityScoreBreakdown,
  ScoutRunStats,
  XScanCursor,
} from "../lib/scout/types";

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const platformEnum = pgEnum("platform", [
  "x",
  "linkedin",
  "threads",
  "bluesky",
]);

export const scoutRunStatusEnum = pgEnum("scout_run_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const opportunityStatusEnum = pgEnum("opportunity_status", [
  "new",
  "saved",
  "dismissed",
  "replied",
]);

// Reply styles (lib/replies/styles.ts); new ones are appended, never reordered
export const replyVariantEnum = pgEnum("reply_variant", REPLY_STYLES);

export const planEnum = pgEnum("plan", PLAN_IDS);

/** Who started a run: the Run Scout button or the Day 18 scheduler */
export const runTriggerEnum = pgEnum("run_trigger", ["manual", "auto"]);

export const opportunitySensitivityEnum = pgEnum(
  "opportunity_sensitivity",
  OPPORTUNITY_SENSITIVITIES,
);

export const replyStatusEnum = pgEnum("reply_status", [
  "draft",
  "approved",
  "posted",
  "discarded",
]);

export const profilesTable = pgTable("profiles", {
  id: uuid().primaryKey().defaultRandom(),
  // References the Neon Auth user (neon_auth.user.id)
  userId: text().notNull().unique(),
  displayName: text(),
  xHandle: text(),
  occupation: text(),
  bio: text(),
  targetAudience: text(),
  primaryGoal: text(),
  knownFor: text(),
  // Day 14 guided onboarding (cold start)
  topics: text(),
  avoidTopics: text(),
  voiceDescription: text(),

  voiceBrain: jsonb().$type<StoredVoiceBrain>(),
  interestBrain: jsonb().$type<StoredInterestBrain>(),
  goalBrain: jsonb().$type<StoredGoalBrain>(),
  // Day 13: conclusions from repeated behavior; null until first learned
  learningProfile: jsonb().$type<LearningProfile>(),
  // What the user wants to reply to, and what not. Written by the user, kept
  // apart from the Brain: a Brain rebuild never touches it. Null: none yet.
  replyPreferences: jsonb().$type<ReplyPreferences>(),
  // Standing rules the user wrote for every reply, e.g. "never start with 'Exactly'"
  replyRules: text().array().notNull().default(sql`'{}'::text[]`),
  // How many opportunities they want; sets the score a post needs to surface
  opportunitySensitivity: opportunitySensitivityEnum().notNull().default("balanced"),
  // Usage limits come from the plan (lib/billing/plans.ts); overrides are per user
  plan: planEnum().notNull().default("free"),
  usageLimitOverrides: jsonb().$type<Partial<UsageLimits>>(),
  // Day 18 Automatic Scout: off until the user turns it on
  autoScanEnabled: boolean().notNull().default(false),
  /** One of the plan's intervals; null: the plan's default */
  autoScanIntervalMinutes: integer(),
  /** When the scheduler should scan next; null while off */
  nextScanAt: timestamp({ withTimezone: true }),
  lastAutoScanAt: timestamp({ withTimezone: true }),

  onboardingCompleted: boolean().notNull().default(false),
  ...timestamps,
});

// The user's own connected accounts
export const socialAccountsTable = pgTable(
  "social_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    platform: platformEnum().notNull(),
    platformUserId: text().notNull(),
    handle: text().notNull(),
    displayName: text(),
    avatarUrl: text(),
    lastSyncedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique().on(t.profileId, t.platform, t.platformUserId)],
);

export const postsTable = pgTable(
  "posts",
  {
    id: uuid().primaryKey().defaultRandom(),
    socialAccountId: uuid()
      .notNull()
      .references(() => socialAccountsTable.id, { onDelete: "cascade" }),
    platformPostId: text().notNull(),
    content: text().notNull(),
    url: text(),
    metrics: jsonb().$type<{
      likes?: number;
      replies?: number;
      reposts?: number;
      impressions?: number;
    }>(),
    publishedAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    // Per account, not global: two Scout profiles can hold the same X post
    unique().on(t.socialAccountId, t.platformPostId),
    index().on(t.socialAccountId, t.publishedAt.desc()),
  ],
);

// Other people's accounts the user wants to monitor
export const watchlistAccountsTable = pgTable(
  "watchlist_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    platform: platformEnum().notNull(),
    platformUserId: text().notNull(),
    handle: text().notNull(),
    displayName: text(),
    avatarUrl: text(),
    notes: text(),
    isActive: boolean().notNull().default(true),
    lastScannedAt: timestamp({ withTimezone: true }),
    // Deprecated (Day 17): the cursor lives on x_accounts, shared by all
    // watchers. Kept as the starting point when an x_accounts row is created.
    xCursor: jsonb().$type<XScanCursor>(),
    ...timestamps,
  },
  (t) => [
    unique().on(t.profileId, t.platform, t.platformUserId),
    index().on(t.profileId, t.isActive),
  ],
);

export const scoutRunsTable = pgTable(
  "scout_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    status: scoutRunStatusEnum().notNull().default("pending"),
    trigger: runTriggerEnum().notNull().default("manual"),
    opportunitiesFound: integer().notNull().default(0),
    error: text(),
    stats: jsonb().$type<ScoutRunStats>(),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.profileId, t.createdAt.desc()),
    index().on(t.status),
    // At most one active run per profile, even with double clicks or two tabs
    uniqueIndex("scout_runs_one_active_per_profile")
      .on(t.profileId)
      .where(sql`${t.status} in ('pending', 'running')`),
  ],
);

export const opportunitiesTable = pgTable(
  "opportunities",
  {
    id: uuid().primaryKey().defaultRandom(),
    scoutRunId: uuid()
      .notNull()
      .references(() => scoutRunsTable.id, { onDelete: "cascade" }),
    // Denormalized from scoutRun so the feed can be queried without a join
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    platform: platformEnum().notNull(),
    platformPostId: text().notNull(),
    postUrl: text(),
    authorPlatformUserId: text(),
    authorHandle: text(),
    content: text().notNull(),
    score: real(),
    scoreBreakdown: jsonb().$type<OpportunityScoreBreakdown>(),
    // Why this user should join the conversation
    reason: text(),
    // What this user specifically has to add
    suggestedAngle: text(),
    // What the post is about, named after a Scout Brain topic when one fits
    topic: text(),
    status: opportunityStatusEnum().notNull().default("new"),
    postedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Same post never surfaces twice for one profile
    unique().on(t.profileId, t.platform, t.platformPostId),
    index().on(t.scoutRunId),
    index().on(t.profileId, t.status, t.score.desc()),
    index().on(t.profileId, t.createdAt.desc()),
  ],
);

export const repliesTable = pgTable(
  "replies",
  {
    id: uuid().primaryKey().defaultRandom(),
    opportunityId: uuid()
      .notNull()
      .references(() => opportunitiesTable.id, { onDelete: "cascade" }),
    variant: replyVariantEnum().notNull(),
    // What the AI wrote, never changed; Day 12 learns from content vs this
    originalContent: text().notNull(),
    // What the user kept, after any edits
    content: text().notNull(),
    // draft → approved when copied; discarded when regenerated over
    status: replyStatusEnum().notNull().default("draft"),
    // What the user asked to change when regenerating ("shorter"); null otherwise
    instruction: text(),
    platformReplyId: text(),
    postedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.opportunityId, t.createdAt.desc()),
    index().on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Day 6 Brain eval: hand-picked posts by other people, rated by the user.
// ---------------------------------------------------------------------------

export const evalCaseCategoryEnum = pgEnum("eval_case_category", [
  "very_relevant",
  "somewhat_relevant",
  "knows_little_to_add",
  "irrelevant",
]);

export const evalCasesTable = pgTable(
  "eval_cases",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    authorHandle: text().notNull(),
    content: text().notNull(),
    // The user's own expectation; never shown to the model
    category: evalCaseCategoryEnum().notNull(),
    ...timestamps,
  },
  (t) => [index().on(t.profileId, t.createdAt)],
);

export const evalRunsTable = pgTable(
  "eval_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    // Which Scout Brain version was evaluated
    brainAnalyzedAt: timestamp({ withTimezone: true }).notNull(),
    model: text().notNull(),
    ...timestamps,
  },
  (t) => [index().on(t.profileId, t.createdAt.desc())],
);

export const evalResultsTable = pgTable(
  "eval_results",
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid()
      .notNull()
      .references(() => evalRunsTable.id, { onDelete: "cascade" }),
    caseId: uuid()
      .notNull()
      .references(() => evalCasesTable.id, { onDelete: "cascade" }),
    decision: jsonb().$type<EngagementDecision>().notNull(),
    reply: text().notNull(),
    // The user's old posts given to the model as voice examples
    contextPostIds: jsonb().$type<string[]>().notNull(),

    // User ratings; null until rated
    voiceScore: integer(),
    wouldPost: boolean(),
    tooGeneric: boolean(),
    decisionCorrect: boolean(),
    notes: text(),
    ratedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique().on(t.runId, t.caseId)],
);

// ---------------------------------------------------------------------------
// Day 8 scan pipeline
// ---------------------------------------------------------------------------

export const postKindEnum = pgEnum("post_kind", ["post", "reply", "quote", "repost"]);

export const candidateLabelEnum = pgEnum("candidate_label", ["yes", "maybe", "no"]);

/** "Did we miss this?": the user's verdict on a post Scout didn't surface */
export const MISS_RATINGS = ["strong", "acceptable", "weak", "not_for_me"] as const;
export const missRatingEnum = pgEnum("miss_rating", MISS_RATINGS);
/** Why it was shown: near the threshold, or a random lower-scored post (unbiased sample) */
export const missSampleEnum = pgEnum("miss_sample", ["near_threshold", "random_low"]);

/** Posts of other people imported from exports; a post source next to the X API. */
export const importedPostsTable = pgTable(
  "imported_posts",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    platform: platformEnum().notNull(),
    platformPostId: text().notNull(),
    authorHandle: text().notNull(),
    content: text().notNull(),
    url: text().notNull(),
    kind: postKindEnum().notNull(),
    metrics: jsonb().$type<{
      likes?: number;
      replies?: number;
      reposts?: number;
      impressions?: number;
    }>(),
    postedAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique().on(t.profileId, t.platform, t.platformPostId),
    index().on(t.profileId, t.platform, t.authorHandle),
  ],
);

/** Valid posts from a scan, waiting for the Day 9 Opportunity Engine. */
export const scoutCandidatesTable = pgTable(
  "scout_candidates",
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid()
      .notNull()
      .references(() => scoutRunsTable.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    watchlistAccountId: uuid().references(() => watchlistAccountsTable.id, {
      onDelete: "set null",
    }),
    platform: platformEnum().notNull(),
    platformPostId: text().notNull(),
    authorPlatformUserId: text(),
    authorHandle: text().notNull(),
    content: text().notNull(),
    url: text().notNull(),
    kind: postKindEnum().notNull(),
    metrics: jsonb().$type<{
      likes?: number;
      replies?: number;
      reposts?: number;
      impressions?: number;
    }>(),
    postedAt: timestamp({ withTimezone: true }).notNull(),
    // Which post source delivered it, e.g. "x_api" or "import"
    source: text().notNull(),
    // Day 17: a delivered post the filters turned down (reply, too old…).
    // Kept so it's never delivered, charged or evaluated again; never scored.
    // Day 20: or the scoring pre-filter's reason (lib/scout/prefilter.ts)
    rejectedReason: text().$type<CandidateFilterReason | PrefilterReason>(),

    // Day 9 scoring, kept for every candidate (not only surfaced ones) so the
    // threshold can be tuned on real data. Null until scored.
    score: integer(),
    scoreBreakdown: jsonb().$type<OpportunityScoreBreakdown>(),
    shouldEngage: boolean(),
    reason: text(),
    suggestedAngle: text(),
    topic: text(),
    scoredAt: timestamp({ withTimezone: true }),

    // The user's own blind judgment, compared with Scout's score in the
    // ranking check. Null until labeled.
    userLabel: candidateLabelEnum(),
    labeledAt: timestamp({ withTimezone: true }),

    // Day 21 "Did we miss this?": a rating of a post Scout didn't surface,
    // kept apart from userLabel. Null until rated.
    missRating: missRatingEnum(),
    missSample: missSampleEnum(),
    missRatedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // A post becomes a candidate once per profile: later scans skip it
    unique().on(t.profileId, t.platform, t.platformPostId),
    index().on(t.runId),
    index().on(t.profileId, t.scoredAt),
  ],
);

// ---------------------------------------------------------------------------
// Day 14 cold start: the user's own writing, before they have any X history
// ---------------------------------------------------------------------------

// onboarding: calibration replies; opinion: takes the user wrote down later
export const voiceSampleSourceEnum = pgEnum("voice_sample_source", ["onboarding", "opinion"]);

export const voiceSamplesTable = pgTable(
  "voice_samples",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    promptPost: text().notNull(),
    userReply: text().notNull(),
    source: voiceSampleSourceEnum().notNull().default("onboarding"),
    ...timestamps,
  },
  (t) => [index().on(t.profileId, t.createdAt)],
);

export type Profile = typeof profilesTable.$inferSelect;
export type NewProfile = typeof profilesTable.$inferInsert;
export type SocialAccount = typeof socialAccountsTable.$inferSelect;
export type NewSocialAccount = typeof socialAccountsTable.$inferInsert;
export type Post = typeof postsTable.$inferSelect;
export type NewPost = typeof postsTable.$inferInsert;
export type WatchlistAccount = typeof watchlistAccountsTable.$inferSelect;
export type NewWatchlistAccount = typeof watchlistAccountsTable.$inferInsert;
export type ScoutRun = typeof scoutRunsTable.$inferSelect;
export type NewScoutRun = typeof scoutRunsTable.$inferInsert;
export type Opportunity = typeof opportunitiesTable.$inferSelect;
export type NewOpportunity = typeof opportunitiesTable.$inferInsert;
export type Reply = typeof repliesTable.$inferSelect;
export type NewReply = typeof repliesTable.$inferInsert;
export type EvalCase = typeof evalCasesTable.$inferSelect;
export type EvalRun = typeof evalRunsTable.$inferSelect;
export type EvalResult = typeof evalResultsTable.$inferSelect;
export type ImportedPost = typeof importedPostsTable.$inferSelect;
export type ScoutCandidate = typeof scoutCandidatesTable.$inferSelect;
export type VoiceSample = typeof voiceSamplesTable.$inferSelect;

// X API usage per UTC day, across all of Scout (one token, one credit balance).
// Request counts estimate usage; they are not X's billing.
export const xApiUsageTable = pgTable("x_api_usage", {
  day: date({ mode: "string" }).primaryKey(),
  /** Attempted requests, including failed ones and retries */
  requests: integer().notNull().default(0),
  failedRequests: integer().notNull().default(0),
  retriedRequests: integer().notNull().default(0),
  postsReturned: integer().notNull().default(0),
  postsAccepted: integer().notNull().default(0),
  runsCompleted: integer().notNull().default(0),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type XApiUsage = typeof xApiUsageTable.$inferSelect;

export const aiOperationEnum = pgEnum("ai_operation", [
  "opportunity_scoring",
  "reply_generation",
  "brain_creation",
  "memory_learning",
  "brain_eval",
]);

// One row per OpenAI call: actual token usage from the API, and the cost
// estimated from lib/ai/pricing.ts at the time of the call.
export const aiUsageTable = pgTable(
  "ai_usage",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    // Set for calls made during a Scout run (opportunity scoring)
    scoutRunId: uuid().references(() => scoutRunsTable.id, { onDelete: "set null" }),
    operation: aiOperationEnum().notNull(),
    /** As the API reports it, e.g. "gpt-5.5-2026-04-23" */
    model: text().notNull(),
    /** All input tokens, cached ones included */
    inputTokens: integer().notNull(),
    cachedInputTokens: integer().notNull(),
    /** All output tokens, reasoning ones included */
    outputTokens: integer().notNull(),
    reasoningTokens: integer().notNull(),
    /** Null when the model has no configured price */
    costUsd: doublePrecision(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.profileId, t.createdAt.desc()), index().on(t.scoutRunId)],
);

export type AiUsage = typeof aiUsageTable.$inferSelect;
export type AiOperation = (typeof aiOperationEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// Day 17: shared X fetching. An X account's posts are fetched once and cached
// for every Scout user who watches it; what each user does with them (scoring,
// opportunities, replies) stays per user in scout_candidates and beyond.
// ---------------------------------------------------------------------------

export const xFetchStatusEnum = pgEnum("x_fetch_status", ["ok", "failed"]);

/** One row per X account anyone watches; the shared fetch state. */
export const xAccountsTable = pgTable("x_accounts", {
  platformUserId: text().primaryKey(),
  handle: text().notNull(),
  /** Where the shared timeline read stopped; moves only after posts are cached */
  cursor: jsonb().$type<XScanCursor>(),
  lastFetchedAt: timestamp({ withTimezone: true }),
  lastFetchStatus: xFetchStatusEnum(),
  lastFetchError: text(),
  // Database lock so serverless instances don't fetch the same account twice;
  // an expired lock can be taken over
  fetchLockToken: uuid(),
  fetchLockedUntil: timestamp({ withTimezone: true }),
  ...timestamps,
});

/** Global cache of fetched X posts, one row per post. */
export const xPostsTable = pgTable(
  "x_posts",
  {
    platformPostId: text().primaryKey(),
    authorPlatformUserId: text()
      .notNull()
      .references(() => xAccountsTable.platformUserId, { onDelete: "cascade" }),
    authorHandle: text().notNull(),
    /** The author's own text, without any quoted post */
    content: text().notNull(),
    url: text().notNull(),
    kind: postKindEnum().notNull(),
    /** Posts this one replies to, quotes or reposts */
    referencedPostIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Quotes: the quoted post's text when X returned it in the same response */
    quotedContent: text(),
    metrics: jsonb().$type<{
      likes?: number;
      replies?: number;
      reposts?: number;
      impressions?: number;
    }>(),
    postedAt: timestamp({ withTimezone: true }).notNull(),
    /** When Scout first cached it */
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.authorPlatformUserId, t.postedAt.desc())],
);

export type XAccount = typeof xAccountsTable.$inferSelect;
export type XPost = typeof xPostsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Day 18: Automatic Scout. A durable job per scheduled scan, so any number of
// instances can share the work, retries survive restarts and every skipped or
// failed scan leaves a record.
// ---------------------------------------------------------------------------

export const scanJobStatusEnum = pgEnum("scan_job_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export const scanJobsTable = pgTable(
  "scan_jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    status: scanJobStatusEnum().notNull().default("pending"),
    /** Why it was skipped, e.g. "budget_x_reads", "run_limit", "scan_running" */
    skipReason: text(),
    /** Runs attempted so far; failed attempts retry with backoff */
    attempts: integer().notNull().default(0),
    /** Not claimed before this moment (backoff after a failure) */
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The worker running it, and until when its claim holds */
    lockedBy: text(),
    lockedUntil: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    durationMs: integer(),
    scoutRunId: uuid().references(() => scoutRunsTable.id, { onDelete: "set null" }),
    /** Watched accounts whose shared fetch another worker held (skipped this time) */
    busyAccounts: integer().notNull().default(0),
    error: text(),
    ...timestamps,
  },
  (t) => [
    // At most one open job per profile, whatever the number of schedulers
    uniqueIndex("scan_jobs_one_open_per_profile")
      .on(t.profileId)
      .where(sql`${t.status} in ('pending', 'running')`),
    index().on(t.status, t.runAfter),
    index().on(t.profileId, t.createdAt.desc()),
  ],
);

export type ScanJob = typeof scanJobsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Day 19: Smart notifications. A notification is one strong opportunity from
// an automatic scan (the in-app history); each channel it goes out on is a
// delivery: a durable job with its own status, retries and claim.
// ---------------------------------------------------------------------------

/** Channels a notification can be delivered on; new ones are appended */
export const notificationChannelEnum = pgEnum("notification_channel", ["slack"]);

export const notificationDeliveryStatusEnum = pgEnum("notification_delivery_status", [
  "pending",
  "sending",
  "sent",
  "failed",
  /** Never sent on purpose: quiet hours, daily limit, alerts off */
  "suppressed",
]);

export const slackConnectionStatusEnum = pgEnum("slack_connection_status", [
  "active",
  /** Token revoked, app uninstalled or a scope missing: connect again */
  "needs_reconnect",
  /** Channel deleted, archived or the bot was removed: pick another */
  "channel_unavailable",
]);

/** One Slack workspace per Scout user. The bot token is stored encrypted. */
export const slackConnectionsTable = pgTable("slack_connections", {
  id: uuid().primaryKey().defaultRandom(),
  profileId: uuid()
    .notNull()
    .unique()
    .references(() => profilesTable.id, { onDelete: "cascade" }),
  teamId: text().notNull(),
  teamName: text().notNull(),
  botUserId: text(),
  scopes: text().notNull(),
  /** AES-256-GCM (lib/crypto/tokens.ts); never sent to the browser */
  encryptedBotToken: text().notNull(),
  /** Null until the user picks a channel and Scout verifies it can post there */
  channelId: text(),
  channelName: text(),
  status: slackConnectionStatusEnum().notNull().default("active"),
  lastError: text(),
  ...timestamps,
});

export type SlackConnection = typeof slackConnectionsTable.$inferSelect;

/** Notification preferences; a missing row means the defaults (alerts off). */
export const notificationSettingsTable = pgTable("notification_settings", {
  profileId: uuid()
    .primaryKey()
    .references(() => profilesTable.id, { onDelete: "cascade" }),
  slackEnabled: boolean().notNull().default(false),
  minScore: integer().notNull().default(80),
  maxPerDay: integer().notNull().default(5),
  /** Local hours 0–23; both null: no quiet hours. Start > end spans midnight. */
  quietHoursStart: integer(),
  quietHoursEnd: integer(),
  /** IANA name; quiet hours and the daily limit use this day */
  timezone: text().notNull().default("UTC"),
  ...timestamps,
});

export type NotificationSettings = typeof notificationSettingsTable.$inferSelect;

export const notificationsTable = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    opportunityId: uuid()
      .notNull()
      .references(() => opportunitiesTable.id, { onDelete: "cascade" }),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One notification per opportunity, however often it is queued
    unique().on(t.opportunityId),
    index().on(t.profileId, t.createdAt.desc()),
  ],
);

export type Notification = typeof notificationsTable.$inferSelect;

export const notificationDeliveriesTable = pgTable(
  "notification_deliveries",
  {
    id: uuid().primaryKey().defaultRandom(),
    notificationId: uuid()
      .notNull()
      .references(() => notificationsTable.id, { onDelete: "cascade" }),
    // Denormalized for per-user queries and the daily limit
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum().notNull(),
    status: notificationDeliveryStatusEnum().notNull().default("pending"),
    /** Why it was suppressed or failed for good, e.g. "quiet_hours", "token_revoked" */
    reason: text(),
    /** The user's local day it counts toward the daily limit */
    day: date({ mode: "string" }).notNull(),
    attempts: integer().notNull().default(0),
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lockedBy: text(),
    lockedUntil: timestamp({ withTimezone: true }),
    /** Slack message ts */
    providerMessageId: text(),
    error: text(),
    sentAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // At most one delivery per notification and channel: no duplicate alerts
    unique().on(t.notificationId, t.channel),
    index().on(t.status, t.runAfter),
    index().on(t.profileId, t.createdAt.desc()),
  ],
);

export type NotificationDelivery = typeof notificationDeliveriesTable.$inferSelect;

/**
 * Alerts reserved per user, channel and local day. One conditional upsert
 * reserves a slot, so concurrent workers can't exceed the daily limit.
 */
export const notificationDailyCountsTable = pgTable(
  "notification_daily_counts",
  {
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum().notNull(),
    day: date({ mode: "string" }).notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.channel, t.day] })],
);
