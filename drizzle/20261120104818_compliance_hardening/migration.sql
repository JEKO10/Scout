CREATE TABLE "account_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"userId" text NOT NULL UNIQUE,
	"profileId" uuid NOT NULL,
	"status" text NOT NULL,
	"steps" jsonb DEFAULT '{}' NOT NULL,
	"error" text,
	"completedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_compliance_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"type" text NOT NULL,
	"xJobId" text,
	"status" text NOT NULL,
	"idCount" integer DEFAULT 0 NOT NULL,
	"downloadUrl" text,
	"results" jsonb,
	"error" text,
	"completedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "contentRemovedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "contentRemovedReason" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "contentRemovedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "contentRemovedReason" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "deletionRequestedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "contentRemovedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "contentRemovedReason" text;--> statement-breakpoint
CREATE INDEX "account_deletions_status_index" ON "account_deletions" ("status");--> statement-breakpoint
CREATE INDEX "x_compliance_jobs_type_createdAt_index" ON "x_compliance_jobs" ("type","createdAt" DESC NULLS LAST);