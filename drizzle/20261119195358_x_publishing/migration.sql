CREATE TABLE "x_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"draftId" uuid,
	"xUserId" text,
	"text" text NOT NULL,
	"hasUrl" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"approvedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduledAt" timestamp with time zone,
	"timeZone" text,
	"claimedUntil" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attemptedAt" timestamp with time zone,
	"nextAttemptAt" timestamp with time zone,
	"xPostId" text UNIQUE,
	"publishedAt" timestamp with time zone,
	"error" text,
	"reservedUsd" double precision DEFAULT 0 NOT NULL,
	"costUsd" double precision,
	"windowStart" date,
	"windowSlot" integer,
	"reconcileChecks" integer DEFAULT 0 NOT NULL,
	"reconcileReads" integer DEFAULT 0 NOT NULL,
	"deletedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "x_publications_profileId_windowStart_windowSlot_unique" UNIQUE("profileId","windowStart","windowSlot")
);
--> statement-breakpoint
CREATE TABLE "x_publish_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"month" date NOT NULL,
	"committedUsd" double precision DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "x_publish_budgets_profileId_month_unique" UNIQUE("profileId","month")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "x_publications_one_active_per_draft" ON "x_publications" ("draftId") WHERE "status" in ('approved', 'scheduled', 'publishing', 'unknown');--> statement-breakpoint
CREATE INDEX "x_publications_status_scheduledAt_index" ON "x_publications" ("status","scheduledAt");--> statement-breakpoint
CREATE INDEX "x_publications_profileId_createdAt_index" ON "x_publications" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "x_publications" ADD CONSTRAINT "x_publications_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "x_publications" ADD CONSTRAINT "x_publications_draftId_content_drafts_id_fkey" FOREIGN KEY ("draftId") REFERENCES "content_drafts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "x_publish_budgets" ADD CONSTRAINT "x_publish_budgets_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;