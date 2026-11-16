CREATE TYPE "lead_intent" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
ALTER TYPE "ai_operation" ADD VALUE 'lead_icp';--> statement-breakpoint
ALTER TYPE "ai_operation" ADD VALUE 'lead_classification';--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"candidateId" uuid,
	"opportunityId" uuid,
	"discoveryTopicId" uuid,
	"platform" "platform" NOT NULL,
	"platformPostId" text NOT NULL,
	"authorPlatformUserId" text,
	"authorHandle" text NOT NULL,
	"postUrl" text NOT NULL,
	"content" text NOT NULL,
	"postedAt" timestamp with time zone NOT NULL,
	"intent" "lead_intent" NOT NULL,
	"score" integer NOT NULL,
	"scoreBreakdown" jsonb NOT NULL,
	"evidence" text NOT NULL,
	"reason" text NOT NULL,
	"suggestedAction" text NOT NULL,
	"saved" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_profileId_platform_platformPostId_unique" UNIQUE("profileId","platform","platformPostId")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "leadProfile" jsonb;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "leadCheckedAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "leads_profileId_score_index" ON "leads" ("profileId","score" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_candidateId_scout_candidates_id_fkey" FOREIGN KEY ("candidateId") REFERENCES "scout_candidates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_opportunityId_opportunities_id_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_discoveryTopicId_discovery_topics_id_fkey" FOREIGN KEY ("discoveryTopicId") REFERENCES "discovery_topics"("id") ON DELETE SET NULL;