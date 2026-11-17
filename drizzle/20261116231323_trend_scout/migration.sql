CREATE TYPE "trend_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "trend_status" AS ENUM('rising', 'stable', 'declining', 'newly_detected', 'insufficient_history');--> statement-breakpoint
CREATE TABLE "trends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary" text,
	"why" text,
	"discoveryTopicId" uuid,
	"status" "trend_status" NOT NULL,
	"confidence" "trend_confidence" NOT NULL,
	"score" integer NOT NULL,
	"relevance" integer NOT NULL,
	"scoreBreakdown" jsonb NOT NULL,
	"momentum" jsonb NOT NULL,
	"dailyCounts" jsonb NOT NULL,
	"postCount" integer NOT NULL,
	"authorCount" integer NOT NULL,
	"engagement" integer NOT NULL,
	"representativeCandidateIds" uuid[] NOT NULL,
	"firstPostAt" timestamp with time zone NOT NULL,
	"lastPostAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trends_profileId_key_unique" UNIQUE("profileId","key")
);
--> statement-breakpoint
CREATE INDEX "trends_profileId_score_index" ON "trends" ("profileId","score" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "trends" ADD CONSTRAINT "trends_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "trends" ADD CONSTRAINT "trends_discoveryTopicId_discovery_topics_id_fkey" FOREIGN KEY ("discoveryTopicId") REFERENCES "discovery_topics"("id") ON DELETE SET NULL;