ALTER TYPE "ai_operation" ADD VALUE 'discovery_keywords';--> statement-breakpoint
CREATE TABLE "discovery_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"keywords" text[] NOT NULL,
	"excludedKeywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"sinceId" text,
	"lastSearchedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "discoveryTopicId" uuid;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "discoveryTopicId" uuid;--> statement-breakpoint
CREATE INDEX "discovery_topics_profileId_index" ON "discovery_topics" ("profileId");--> statement-breakpoint
ALTER TABLE "discovery_topics" ADD CONSTRAINT "discovery_topics_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_discoveryTopicId_discovery_topics_id_fkey" FOREIGN KEY ("discoveryTopicId") REFERENCES "discovery_topics"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD CONSTRAINT "scout_candidates_discoveryTopicId_discovery_topics_id_fkey" FOREIGN KEY ("discoveryTopicId") REFERENCES "discovery_topics"("id") ON DELETE SET NULL;