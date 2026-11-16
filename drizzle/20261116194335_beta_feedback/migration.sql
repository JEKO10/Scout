CREATE TYPE "feedback_category" AS ENUM('bug', 'feature', 'general');--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"category" "feedback_category" NOT NULL,
	"message" text,
	"path" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "feedback_profileId_createdAt_index" ON "feedback" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feedback_createdAt_index" ON "feedback" ("createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;