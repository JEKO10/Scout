CREATE TYPE "post_kind" AS ENUM('post', 'reply', 'quote', 'repost');--> statement-breakpoint
CREATE TABLE "imported_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platformPostId" text NOT NULL,
	"authorHandle" text NOT NULL,
	"content" text NOT NULL,
	"url" text NOT NULL,
	"kind" "post_kind" NOT NULL,
	"metrics" jsonb,
	"postedAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imported_posts_profileId_platform_platformPostId_unique" UNIQUE("profileId","platform","platformPostId")
);
--> statement-breakpoint
CREATE TABLE "scout_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"runId" uuid NOT NULL,
	"profileId" uuid NOT NULL,
	"watchlistAccountId" uuid,
	"platform" "platform" NOT NULL,
	"platformPostId" text NOT NULL,
	"authorPlatformUserId" text,
	"authorHandle" text NOT NULL,
	"content" text NOT NULL,
	"url" text NOT NULL,
	"kind" "post_kind" NOT NULL,
	"metrics" jsonb,
	"postedAt" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_candidates_profileId_platform_platformPostId_unique" UNIQUE("profileId","platform","platformPostId")
);
--> statement-breakpoint
ALTER TABLE "scout_runs" ADD COLUMN "stats" jsonb;--> statement-breakpoint
CREATE INDEX "imported_posts_profileId_platform_authorHandle_index" ON "imported_posts" ("profileId","platform","authorHandle");--> statement-breakpoint
CREATE INDEX "scout_candidates_runId_index" ON "scout_candidates" ("runId");--> statement-breakpoint
-- Day 7 runs were only queued and nothing will ever process them. Close them
-- so the one-active-run index below can be created.
UPDATE "scout_runs" SET "status" = 'failed', "error" = 'Queued before the scan pipeline existed; never processed.', "completedAt" = now() WHERE "status" in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "scout_runs_one_active_per_profile" ON "scout_runs" ("profileId") WHERE "status" in ('pending', 'running');--> statement-breakpoint
ALTER TABLE "imported_posts" ADD CONSTRAINT "imported_posts_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD CONSTRAINT "scout_candidates_runId_scout_runs_id_fkey" FOREIGN KEY ("runId") REFERENCES "scout_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD CONSTRAINT "scout_candidates_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD CONSTRAINT "scout_candidates_watchlistAccountId_watchlist_accounts_id_fkey" FOREIGN KEY ("watchlistAccountId") REFERENCES "watchlist_accounts"("id") ON DELETE SET NULL;