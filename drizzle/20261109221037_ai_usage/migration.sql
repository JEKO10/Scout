CREATE TYPE "ai_operation" AS ENUM('opportunity_scoring', 'reply_generation', 'brain_creation', 'memory_learning', 'brain_eval');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"scoutRunId" uuid,
	"operation" "ai_operation" NOT NULL,
	"model" text NOT NULL,
	"inputTokens" integer NOT NULL,
	"cachedInputTokens" integer NOT NULL,
	"outputTokens" integer NOT NULL,
	"reasoningTokens" integer NOT NULL,
	"costUsd" double precision,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ai_usage_profileId_createdAt_index" ON "ai_usage" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_usage_scoutRunId_index" ON "ai_usage" ("scoutRunId");--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_scoutRunId_scout_runs_id_fkey" FOREIGN KEY ("scoutRunId") REFERENCES "scout_runs"("id") ON DELETE SET NULL;