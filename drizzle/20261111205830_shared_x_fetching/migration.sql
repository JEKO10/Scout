CREATE TYPE "x_fetch_status" AS ENUM('ok', 'failed');--> statement-breakpoint
CREATE TABLE "x_accounts" (
	"platformUserId" text PRIMARY KEY,
	"handle" text NOT NULL,
	"cursor" jsonb,
	"lastFetchedAt" timestamp with time zone,
	"lastFetchStatus" "x_fetch_status",
	"lastFetchError" text,
	"fetchLockToken" uuid,
	"fetchLockedUntil" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_posts" (
	"platformPostId" text PRIMARY KEY,
	"authorPlatformUserId" text NOT NULL,
	"authorHandle" text NOT NULL,
	"content" text NOT NULL,
	"url" text NOT NULL,
	"kind" "post_kind" NOT NULL,
	"referencedPostIds" text[] DEFAULT '{}'::text[] NOT NULL,
	"quotedContent" text,
	"metrics" jsonb,
	"postedAt" timestamp with time zone NOT NULL,
	"fetchedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "rejectedReason" text;--> statement-breakpoint
CREATE INDEX "x_posts_authorPlatformUserId_postedAt_index" ON "x_posts" ("authorPlatformUserId","postedAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "x_posts" ADD CONSTRAINT "x_posts_authorPlatformUserId_x_accounts_platformUserId_fkey" FOREIGN KEY ("authorPlatformUserId") REFERENCES "x_accounts"("platformUserId") ON DELETE CASCADE;