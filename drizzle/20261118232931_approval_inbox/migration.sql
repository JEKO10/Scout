CREATE TABLE "inbox_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"itemKey" text NOT NULL,
	"itemType" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"snoozedUntil" timestamp with time zone,
	"meta" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_decisions_profileId_itemKey_unique" UNIQUE("profileId","itemKey")
);
--> statement-breakpoint
CREATE TABLE "inbox_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"slot" integer NOT NULL,
	"entityId" text,
	"status" text NOT NULL,
	"note" text,
	"costUsd" double precision,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_preparations_profileId_day_kind_slot_unique" UNIQUE("profileId","day","kind","slot")
);
--> statement-breakpoint
CREATE TABLE "inbox_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"itemKey" text NOT NULL,
	"kind" text NOT NULL,
	"instruction" text,
	"text" text NOT NULL,
	"outcome" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_drafts" ADD COLUMN "origin" text DEFAULT 'studio' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "autoPrepareEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "inboxPreparedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "inboxLearningResetAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "inbox_decisions_profileId_createdAt_index" ON "inbox_decisions" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inbox_preparations_profileId_createdAt_index" ON "inbox_preparations" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inbox_revisions_profileId_itemKey_createdAt_index" ON "inbox_revisions" ("profileId","itemKey","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inbox_revisions_profileId_createdAt_index" ON "inbox_revisions" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "inbox_decisions" ADD CONSTRAINT "inbox_decisions_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inbox_preparations" ADD CONSTRAINT "inbox_preparations_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inbox_revisions" ADD CONSTRAINT "inbox_revisions_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;