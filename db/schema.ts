import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
import type { ContentReview, IdeaSuggestion } from "../lib/content/types";
import type { LeadProfile, LeadScoreBreakdown } from "../lib/leads/types";
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
import type {
  DailyCount,
  TrendInsight,
  TrendMomentum,
  TrendOpportunityBreakdown,
  TrendScoreBreakdown,
  TrendTiming,
} from "../lib/trends/types";

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
  // Self-reported: the user said (or, before Day 21, copied) they replied
  "replied",
  // Day 21: X's reply composer was opened from Scout; publication unconfirmed
  "reply_opened",
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
  // Day 27 Lead Scout: the user's ideal customer profile; null until set up
  leadProfile: jsonb().$type<LeadProfile>(),
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
    // Day 26 source: the Smart Discovery topic that found it (null: the watchlist)
    discoveryTopicId: uuid().references((): AnyPgColumn => discoveryTopicsTable.id, {
      onDelete: "set null",
    }),
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
    // Day 26: found by a Smart Discovery topic's search (null: the watchlist)
    discoveryTopicId: uuid().references((): AnyPgColumn => discoveryTopicsTable.id, {
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
    // Day 27: checked for buying intent (a lead or not): never checked twice
    leadCheckedAt: timestamp({ withTimezone: true }),
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
  // Day 26: search terms suggested for a Smart Discovery topic
  "discovery_keywords",
  // Day 27 Lead Scout: an ideal customer profile drafted from the Brain, and buying-intent checks
  "lead_icp",
  "lead_classification",
  // Day 30: an AI explanation and content ideas for one trend, on request
  "trend_insight",
  // Day 31 Content Studio (paid from the writing budget, like replies)
  "content_ideas",
  "content_generation",
  "content_review",
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
// Day 21: Reply on X. The user posts in X's own composer (Web Intent); Scout
// records that it opened it, with the final text. Never proof of publication.
// ---------------------------------------------------------------------------

export const replyIntentSourceEnum = pgEnum("reply_intent_source", ["x_web_intent", "clipboard"]);

export const replyIntentStatusEnum = pgEnum("reply_intent_status", [
  /** Composer opened (or text copied); unconfirmed */
  "opened",
  /** The user said they posted it: self-reported, not verified */
  "confirmed",
  /** The user put the opportunity back in their feed */
  "returned",
]);

export const replyIntentsTable = pgTable(
  "reply_intents",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    opportunityId: uuid()
      .notNull()
      .references(() => opportunitiesTable.id, { onDelete: "cascade" }),
    /** The draft it started from; null if written from scratch */
    replyId: uuid().references(() => repliesTable.id, { onDelete: "set null" }),
    /** The original X post replied to */
    platformPostId: text().notNull(),
    /** The final text handed to X, after the user's edits */
    text: text().notNull(),
    /** True when the text differs from the AI draft it started from */
    edited: boolean().notNull().default(false),
    source: replyIntentSourceEnum().notNull(),
    status: replyIntentStatusEnum().notNull().default("opened"),
    /** The opportunity's status before, restored by "Return to opportunities" */
    previousStatus: opportunityStatusEnum().notNull(),
    /** Repeated clicks update this row instead of adding history */
    openCount: integer().notNull().default(1),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp({ withTimezone: true }),
    returnedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // One history entry per opportunity, however often the composer is opened
    unique().on(t.opportunityId),
    index().on(t.profileId, t.openedAt.desc()),
  ],
);

export type ReplyIntent = typeof replyIntentsTable.$inferSelect;

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

/**
 * Day 23: a Paddle subscription and the plan it grants. Written only from
 * verified webhooks; profiles.plan is derived from it.
 */
export const billingSubscriptionsTable = pgTable(
  "billing_subscriptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    paddleSubscriptionId: text().notNull().unique(),
    paddleCustomerId: text().notNull(),
    /** Paddle's status: active, trialing, past_due, paused, canceled */
    status: text().notNull(),
    priceId: text(),
    /** The plan this subscription's price buys; null for an unknown price */
    plan: planEnum(),
    /** Recurring price in the currency charged, minor units, as Paddle reports it */
    unitPrice: jsonb().$type<{ amount: string; currencyCode: string } | null>(),
    currentPeriodEndsAt: timestamp({ withTimezone: true }),
    /** e.g. a cancellation at the end of the period */
    scheduledChange: jsonb().$type<{ action: string; effectiveAt: string } | null>(),
    /** When Paddle last changed the subscription (its updated_at): older states never overwrite newer */
    lastEventAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index().on(t.profileId),
    // One subscription granting access per user: a second is canceled, never stacked
    uniqueIndex("billing_subscriptions_one_active_per_profile")
      .on(t.profileId)
      .where(sql`${t.status} in ('active', 'trialing', 'past_due')`),
  ],
);

export type BillingSubscription = typeof billingSubscriptionsTable.$inferSelect;

/** Every Paddle webhook event handled once: retries and replays are no-ops */
export const paddleWebhookEventsTable = pgTable("paddle_webhook_events", {
  eventId: text().primaryKey(),
  eventType: text().notNull(),
  occurredAt: timestamp({ withTimezone: true }).notNull(),
  profileId: uuid().references(() => profilesTable.id, { onDelete: "set null" }),
  /** applied, stale (older than what's stored), unmatched (no Scout user), ignored */
  outcome: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Day 24 launch analytics: product events, first-party, no third-party
 * tracker. Only an event name, an optional profile, and a few non-sensitive
 * properties (e.g. the plan) — never post or reply text, Brain details,
 * emails or IP addresses. Milestones ("once") are recorded at most once per
 * profile.
 */
export const analyticsEventsTable = pgTable(
  "analytics_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    profileId: uuid().references(() => profilesTable.id, { onDelete: "set null" }),
    /** A per-profile milestone: the first time only */
    once: boolean().notNull().default(false),
    props: jsonb().$type<Record<string, string | number | boolean>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.name, t.createdAt.desc()),
    uniqueIndex("analytics_events_once_per_profile").on(t.name, t.profileId).where(sql`${t.once}`),
  ],
);

export const feedbackCategoryEnum = pgEnum("feedback_category", ["bug", "feature", "general"]);

/** Day 25 beta feedback: what users send from the "Feedback" button */
export const feedbackTable = pgTable(
  "feedback",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    category: feedbackCategoryEnum().notNull(),
    /** Optional, up to 2,000 characters */
    message: text(),
    /** The app page it was sent from, e.g. /dashboard (path only, no query) */
    path: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.profileId, t.createdAt.desc()), index().on(t.createdAt.desc())],
);

export type Feedback = typeof feedbackTable.$inferSelect;

/**
 * Day 26 Smart Discovery: what a user wants Scout to search X for. Searched
 * during the user's scans (same budget, same scoring); never right after
 * creation.
 */
export const discoveryTopicsTable = pgTable(
  "discovery_topics",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    keywords: text().array().notNull(),
    excludedKeywords: text().array().notNull().default(sql`'{}'::text[]`),
    isActive: boolean().notNull().default(true),
    /** Newest post ID seen: the next search only asks X for newer posts */
    sinceId: text(),
    lastSearchedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.profileId)],
);

export type DiscoveryTopic = typeof discoveryTopicsTable.$inferSelect;

export const leadIntentEnum = pgEnum("lead_intent", ["high", "medium", "low"]);

/** Day 28 CRM pipeline, in order */
export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "researching",
  "contacted",
  "replied",
  "qualified",
  "won",
  "lost",
]);

/**
 * Day 27 Lead Scout: a public X post whose author may need what the user
 * offers, with the evidence. One row per user and post; "not a lead" posts
 * aren't stored (their candidate is marked as checked instead).
 */
export const leadsTable = pgTable(
  "leads",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    candidateId: uuid().references(() => scoutCandidatesTable.id, { onDelete: "set null" }),
    /** Linked when the user starts a reply (reuses the opportunity reply flow) */
    opportunityId: uuid().references(() => opportunitiesTable.id, { onDelete: "set null" }),
    discoveryTopicId: uuid().references(() => discoveryTopicsTable.id, { onDelete: "set null" }),
    platform: platformEnum().notNull(),
    platformPostId: text().notNull(),
    /** Public author identifiers only, as X shows them */
    authorPlatformUserId: text(),
    authorHandle: text().notNull(),
    postUrl: text().notNull(),
    content: text().notNull(),
    postedAt: timestamp({ withTimezone: true }).notNull(),
    intent: leadIntentEnum().notNull(),
    score: integer().notNull(),
    scoreBreakdown: jsonb().$type<LeadScoreBreakdown>().notNull(),
    /** Words from the post that show the need */
    evidence: text().notNull(),
    reason: text().notNull(),
    suggestedAction: text().notNull(),
    /** In the CRM (Day 28). Unsaving keeps status, notes and history */
    saved: boolean().notNull().default(false),
    // Day 28 CRM: the user's own pipeline data; rescans never change it
    status: leadStatusEnum().notNull().default("new"),
    followUpAt: timestamp({ withTimezone: true }),
    followUpNote: text(),
    followUpDoneAt: timestamp({ withTimezone: true }),
    lastActivityAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique().on(t.profileId, t.platform, t.platformPostId),
    index().on(t.profileId, t.score.desc()),
    index().on(t.profileId, t.saved, t.status),
    index().on(t.profileId, t.authorPlatformUserId),
  ],
);

export type Lead = typeof leadsTable.$inferSelect;

/** Day 28: the user's private notes on a lead */
export const leadNotesTable = pgTable(
  "lead_notes",
  {
    id: uuid().primaryKey().defaultRandom(),
    leadId: uuid()
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    body: text().notNull(),
    ...timestamps,
  },
  (t) => [index().on(t.leadId, t.createdAt.desc())],
);

export type LeadNote = typeof leadNotesTable.$inferSelect;

export const leadActivityKindEnum = pgEnum("lead_activity_kind", [
  "saved",
  "status_changed",
  "note_added",
  "reply_started",
  "x_opened",
  "contact_logged",
  "response_logged",
  "follow_up_set",
  "follow_up_done",
  "new_signal",
]);

/**
 * Day 28 lead timeline. `userEntered`: something the user told Scout (a
 * contact, a response, a status); otherwise something Scout saw happen in
 * Scout (a save, a reply draft, a link opened). Opening X is never a contact.
 */
export const leadActivitiesTable = pgTable(
  "lead_activities",
  {
    id: uuid().primaryKey().defaultRandom(),
    leadId: uuid()
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    kind: leadActivityKindEnum().notNull(),
    userEntered: boolean().notNull().default(false),
    detail: jsonb().$type<Record<string, string | number | null>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.leadId, t.createdAt.desc())],
);

export type LeadActivity = typeof leadActivitiesTable.$inferSelect;

export const trendStatusEnum = pgEnum("trend_status", [
  // Day 30: small but clearly accelerating (comparable history required)
  "emerging",
  "rising",
  "stable",
  "declining",
  "newly_detected",
  "insufficient_history",
]);
export const trendConfidenceEnum = pgEnum("trend_confidence", ["low", "medium", "high"]);

/**
 * Day 29 Trend Scout: what the posts Scout already collected for a user are
 * about, grouped, with observed momentum. Recomputed after each scan from
 * stored candidates (no extra X or AI calls); a trend without recent posts
 * is removed. Representative posts are referenced by ID, not copied.
 */
export const trendsTable = pgTable(
  "trends",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    /** Normalized label: the same trend keeps its row (and ID) across recomputes */
    key: text().notNull(),
    label: text().notNull(),
    /** Words the posts share most, to make a broad label specific */
    terms: text().array().notNull().default(sql`'{}'::text[]`),
    summary: text(),
    /** Why it matters to the user: the scoring's own reason for its best post */
    why: text(),
    discoveryTopicId: uuid().references(() => discoveryTopicsTable.id, { onDelete: "set null" }),
    status: trendStatusEnum().notNull(),
    confidence: trendConfidenceEnum().notNull(),
    score: integer().notNull(),
    /** Average Scout Brain relevance of its posts, 0–100 */
    relevance: integer().notNull(),
    scoreBreakdown: jsonb().$type<TrendScoreBreakdown>().notNull(),
    momentum: jsonb().$type<TrendMomentum>().notNull(),
    dailyCounts: jsonb().$type<DailyCount[]>().notNull(),
    postCount: integer().notNull(),
    authorCount: integer().notNull(),
    engagement: integer().notNull(),
    /** scout_candidates IDs, best first */
    representativeCandidateIds: uuid().array().notNull(),
    firstPostAt: timestamp({ withTimezone: true }).notNull(),
    lastPostAt: timestamp({ withTimezone: true }).notNull(),
    // Day 30 Trend Intelligence
    /** How worthwhile it is for this user to take part, 0–100 (deterministic) */
    opportunityScore: integer().notNull().default(0),
    opportunityBreakdown: jsonb().$type<TrendOpportunityBreakdown>(),
    timing: text().$type<TrendTiming>(),
    /** Kept by the user: survives recomputes even when the trend goes quiet */
    saved: boolean().notNull().default(false),
    /** AI explanation and content ideas, cached until the evidence changes */
    insight: jsonb().$type<TrendInsight>(),
    insightGeneratedAt: timestamp({ withTimezone: true }),
    /** The evidence the insight was written from: refresh only when it changes meaningfully */
    insightBasis: jsonb().$type<{ postCount: number; candidateIds: string[] }>(),
    /** One generation at a time per trend */
    insightLockedUntil: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique().on(t.profileId, t.key), index().on(t.profileId, t.score.desc())],
);

export type Trend = typeof trendsTable.$inferSelect;

export const contentGoalEnum = pgEnum("content_goal", [
  "grow_audience",
  "build_authority",
  "generate_leads",
  "start_conversations",
  "educate",
  "promote_product",
]);
export const contentFormatEnum = pgEnum("content_format", ["post", "thread"]);
export const contentToneEnum = pgEnum("content_tone", ["professional", "conversational", "bold", "educational"]);
export const contentLengthEnum = pgEnum("content_length", ["short", "medium", "long"]);
export const draftStatusEnum = pgEnum("draft_status", ["draft", "ready"]);

/**
 * Day 31 Content Studio drafts. A thread is an ordered array of posts (one
 * entry each), never one flattened text. Publishing is always manual: Scout
 * only records what the user confirms.
 */
export const contentDraftsTable = pgTable(
  "content_drafts",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    goal: contentGoalEnum().notNull(),
    format: contentFormatEnum().notNull(),
    tone: contentToneEnum().notNull(),
    length: contentLengthEnum().notNull(),
    status: draftStatusEnum().notNull().default("draft"),
    posts: text().array().notNull(),
    topic: text(),
    /** The idea it was written from, if any */
    idea: jsonb().$type<IdeaSuggestion>(),
    sourceTrendId: uuid().references(() => trendsTable.id, { onDelete: "set null" }),
    /** The latest review, kept until the next one */
    review: jsonb().$type<ContentReview>(),
    /** The user said they posted it (Scout can't see X) */
    publishedConfirmedAt: timestamp({ withTimezone: true }),
    // Day 32 Content Calendar: planning only, never automatic posting
    /** When the user plans to post it, UTC */
    plannedAt: timestamp({ withTimezone: true }),
    /** The IANA time zone the plan was made in, e.g. Europe/Belgrade */
    timeZone: text(),
    planNote: text(),
    /** The post's URL on X, if the user adds it after posting (user-entered, not verified) */
    publishedUrl: text(),
    /** Hidden from the calendar and lists, kept */
    archivedAt: timestamp({ withTimezone: true }),
    /** A missed plan is recorded once for analytics; the draft itself doesn't change */
    missedNotedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.profileId, t.updatedAt.desc()), index().on(t.profileId, t.plannedAt)],
);

export type ContentDraft = typeof contentDraftsTable.$inferSelect;
