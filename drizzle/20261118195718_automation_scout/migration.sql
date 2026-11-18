CREATE TYPE "automation_item_kind" AS ENUM('notification', 'review', 'reminder');--> statement-breakpoint
CREATE TYPE "automation_item_status" AS ENUM('open', 'reviewed', 'dismissed', 'done');--> statement-breakpoint
CREATE TYPE "automation_run_status" AS ENUM('running', 'succeeded', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "automation_trigger" AS ENUM('new_opportunity', 'high_intent_lead', 'relevant_trend', 'followup_due', 'content_due', 'strategy_task_due');--> statement-breakpoint
CREATE TABLE "automation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"automationId" uuid,
	"runId" uuid,
	"kind" "automation_item_kind" NOT NULL,
	"eventKey" text NOT NULL,
	"sourceModule" text NOT NULL,
	"entityType" text NOT NULL,
	"entityId" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text NOT NULL,
	"dueAt" timestamp with time zone,
	"status" "automation_item_status" DEFAULT 'open'::"automation_item_status" NOT NULL,
	"readAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_items_runId_kind_unique" UNIQUE("runId","kind")
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"automationId" uuid NOT NULL,
	"profileId" uuid NOT NULL,
	"eventKey" text NOT NULL,
	"entityId" text NOT NULL,
	"status" "automation_run_status" NOT NULL,
	"reason" text,
	"actionResults" jsonb DEFAULT '[]' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"nextRetryAt" timestamp with time zone,
	"counted" boolean DEFAULT false NOT NULL,
	"aiCostUsd" double precision,
	"durationMs" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_automationId_eventKey_unique" UNIQUE("automationId","eventKey")
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger" "automation_trigger" NOT NULL,
	"conditions" jsonb DEFAULT '{}' NOT NULL,
	"actions" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"templateKey" text,
	"cursorAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lockedUntil" timestamp with time zone,
	"lastRunAt" timestamp with time zone,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "automation_items_profileId_status_createdAt_index" ON "automation_items" ("profileId","status","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_runs_profileId_createdAt_index" ON "automation_runs" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_runs_status_nextRetryAt_index" ON "automation_runs" ("status","nextRetryAt");--> statement-breakpoint
CREATE INDEX "automations_profileId_index" ON "automations" ("profileId");--> statement-breakpoint
CREATE INDEX "automations_enabled_lastRunAt_index" ON "automations" ("enabled","lastRunAt");--> statement-breakpoint
ALTER TABLE "automation_items" ADD CONSTRAINT "automation_items_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation_items" ADD CONSTRAINT "automation_items_automationId_automations_id_fkey" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "automation_items" ADD CONSTRAINT "automation_items_runId_automation_runs_id_fkey" FOREIGN KEY ("runId") REFERENCES "automation_runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automationId_automations_id_fkey" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;