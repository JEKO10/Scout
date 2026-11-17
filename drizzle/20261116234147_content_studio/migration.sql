CREATE TYPE "content_format" AS ENUM('post', 'thread');--> statement-breakpoint
CREATE TYPE "content_goal" AS ENUM('grow_audience', 'build_authority', 'generate_leads', 'start_conversations', 'educate', 'promote_product');--> statement-breakpoint
CREATE TYPE "content_length" AS ENUM('short', 'medium', 'long');--> statement-breakpoint
CREATE TYPE "content_tone" AS ENUM('professional', 'conversational', 'bold', 'educational');--> statement-breakpoint
CREATE TYPE "draft_status" AS ENUM('draft', 'ready');--> statement-breakpoint
ALTER TYPE "ai_operation" ADD VALUE 'content_ideas';--> statement-breakpoint
ALTER TYPE "ai_operation" ADD VALUE 'content_generation';--> statement-breakpoint
ALTER TYPE "ai_operation" ADD VALUE 'content_review';--> statement-breakpoint
CREATE TABLE "content_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"title" text NOT NULL,
	"goal" "content_goal" NOT NULL,
	"format" "content_format" NOT NULL,
	"tone" "content_tone" NOT NULL,
	"length" "content_length" NOT NULL,
	"status" "draft_status" DEFAULT 'draft'::"draft_status" NOT NULL,
	"posts" text[] NOT NULL,
	"topic" text,
	"idea" jsonb,
	"sourceTrendId" uuid,
	"review" jsonb,
	"publishedConfirmedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "content_drafts_profileId_updatedAt_index" ON "content_drafts" ("profileId","updatedAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_sourceTrendId_trends_id_fkey" FOREIGN KEY ("sourceTrendId") REFERENCES "trends"("id") ON DELETE SET NULL;