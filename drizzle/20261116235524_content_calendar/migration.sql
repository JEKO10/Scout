ALTER TABLE "content_drafts" ADD COLUMN "plannedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD COLUMN "timeZone" text;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD COLUMN "planNote" text;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD COLUMN "publishedUrl" text;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD COLUMN "archivedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD COLUMN "missedNotedAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "content_drafts_profileId_plannedAt_index" ON "content_drafts" ("profileId","plannedAt");