ALTER TABLE "opportunities" ADD COLUMN "scoreBreakdown" jsonb;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "suggestedAngle" text;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "score" integer;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "scoreBreakdown" jsonb;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "shouldEngage" boolean;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "suggestedAngle" text;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "scoredAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "scout_candidates_profileId_scoredAt_index" ON "scout_candidates" ("profileId","scoredAt");