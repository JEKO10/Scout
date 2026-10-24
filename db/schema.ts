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
  uuid,
} from "drizzle-orm/pg-core";

import type { EngagementDecision } from "../lib/ai/schemas/brainEval";
import type {
  StoredGoalBrain,
  StoredInterestBrain,
  StoredVoiceBrain,
} from "../lib/ai/schemas/scoutBrain";

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
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.profileId, t.createdAt.desc()),
    index().on(t.status),
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
    reason: text(),
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
    content: text().notNull(),
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
