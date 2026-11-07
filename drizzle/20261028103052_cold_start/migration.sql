CREATE TYPE "voice_sample_source" AS ENUM('onboarding');--> statement-breakpoint
CREATE TABLE "voice_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"promptPost" text NOT NULL,
	"userReply" text NOT NULL,
	"source" "voice_sample_source" DEFAULT 'onboarding'::"voice_sample_source" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "topics" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "avoidTopics" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "voiceDescription" text;--> statement-breakpoint
CREATE INDEX "voice_samples_profileId_createdAt_index" ON "voice_samples" ("profileId","createdAt");--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;