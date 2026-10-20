CREATE TYPE "opportunity_status" AS ENUM('new', 'saved', 'dismissed', 'replied');--> statement-breakpoint
CREATE TYPE "platform" AS ENUM('x', 'linkedin', 'threads', 'bluesky');--> statement-breakpoint
CREATE TYPE "reply_status" AS ENUM('draft', 'approved', 'posted', 'discarded');--> statement-breakpoint
CREATE TYPE "scout_run_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"scoutRunId" uuid NOT NULL,
	"profileId" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platformPostId" text NOT NULL,
	"postUrl" text,
	"authorPlatformUserId" text,
	"authorHandle" text,
	"content" text NOT NULL,
	"score" real,
	"reason" text,
	"status" "opportunity_status" DEFAULT 'new'::"opportunity_status" NOT NULL,
	"postedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_profileId_platform_platformPostId_unique" UNIQUE("profileId","platform","platformPostId")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"socialAccountId" uuid NOT NULL,
	"platformPostId" text NOT NULL UNIQUE,
	"content" text NOT NULL,
	"url" text,
	"metrics" jsonb,
	"publishedAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"userId" text NOT NULL UNIQUE,
	"displayName" text,
	"occupation" text,
	"bio" text,
	"targetAudience" text,
	"primaryGoal" text,
	"knownFor" text,
	"voiceBrain" jsonb,
	"interestBrain" jsonb,
	"goalBrain" jsonb,
	"onboardingCompleted" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"opportunityId" uuid NOT NULL,
	"content" text NOT NULL,
	"status" "reply_status" DEFAULT 'draft'::"reply_status" NOT NULL,
	"platformReplyId" text,
	"postedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scout_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"status" "scout_run_status" DEFAULT 'pending'::"scout_run_status" NOT NULL,
	"opportunitiesFound" integer DEFAULT 0 NOT NULL,
	"error" text,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platformUserId" text NOT NULL,
	"handle" text NOT NULL,
	"displayName" text,
	"avatarUrl" text,
	"lastSyncedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_accounts_profileId_platform_platformUserId_unique" UNIQUE("profileId","platform","platformUserId")
);
--> statement-breakpoint
CREATE TABLE "watchlist_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platformUserId" text NOT NULL,
	"handle" text NOT NULL,
	"displayName" text,
	"avatarUrl" text,
	"notes" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"lastScannedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_accounts_profileId_platform_platformUserId_unique" UNIQUE("profileId","platform","platformUserId")
);
--> statement-breakpoint
CREATE INDEX "opportunities_scoutRunId_index" ON "opportunities" ("scoutRunId");--> statement-breakpoint
CREATE INDEX "opportunities_profileId_status_score_index" ON "opportunities" ("profileId","status","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "opportunities_profileId_createdAt_index" ON "opportunities" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_socialAccountId_publishedAt_index" ON "posts" ("socialAccountId","publishedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "replies_opportunityId_createdAt_index" ON "replies" ("opportunityId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "replies_status_index" ON "replies" ("status");--> statement-breakpoint
CREATE INDEX "scout_runs_profileId_createdAt_index" ON "scout_runs" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scout_runs_status_index" ON "scout_runs" ("status");--> statement-breakpoint
CREATE INDEX "watchlist_accounts_profileId_isActive_index" ON "watchlist_accounts" ("profileId","isActive");--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_scoutRunId_scout_runs_id_fkey" FOREIGN KEY ("scoutRunId") REFERENCES "scout_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_socialAccountId_social_accounts_id_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_opportunityId_opportunities_id_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scout_runs" ADD CONSTRAINT "scout_runs_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "watchlist_accounts" ADD CONSTRAINT "watchlist_accounts_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;