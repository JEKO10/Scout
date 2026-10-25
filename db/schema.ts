import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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
import type {
  OpportunityScoreBreakdown,
  ScoutRunStats,
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

export const replyVariantEnum = pgEnum("reply_variant", [
  "natural",
  "stronger_take",
]);

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

  voiceBrain: jsonb().$type<StoredVoiceBrain>(),
  interestBrain: jsonb().$type<StoredInterestBrain>(),
  goalBrain: jsonb().$type<StoredGoalBrain>(),

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
    platformPostId: text().notNull().unique(),
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
  (t) => [index().on(t.socialAccountId, t.publishedAt.desc())],
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

    // Day 9 scoring, kept for every candidate (not only surfaced ones) so the
    // threshold can be tuned on real data. Null until scored.
    score: integer(),
    scoreBreakdown: jsonb().$type<OpportunityScoreBreakdown>(),
    shouldEngage: boolean(),
    reason: text(),
    suggestedAngle: text(),
    scoredAt: timestamp({ withTimezone: true }),

    // The user's own blind judgment, compared with Scout's score in the
    // ranking check. Null until labeled.
    userLabel: candidateLabelEnum(),
    labeledAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // A post becomes a candidate once per profile: later scans skip it
    unique().on(t.profileId, t.platform, t.platformPostId),
    index().on(t.runId),
    index().on(t.profileId, t.scoredAt),
  ],
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
