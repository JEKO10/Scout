CREATE TYPE "run_trigger" AS ENUM('manual', 'auto');--> statement-breakpoint
CREATE TYPE "scan_job_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "scan_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"status" "scan_job_status" DEFAULT 'pending'::"scan_job_status" NOT NULL,
	"skipReason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"runAfter" timestamp with time zone DEFAULT now() NOT NULL,
	"lockedBy" text,
	"lockedUntil" timestamp with time zone,
	"startedAt" timestamp with time zone,
	"finishedAt" timestamp with time zone,
	"durationMs" integer,
	"scoutRunId" uuid,
	"busyAccounts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "autoScanEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "autoScanIntervalMinutes" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "nextScanAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "lastAutoScanAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scout_runs" ADD COLUMN "trigger" "run_trigger" DEFAULT 'manual'::"run_trigger" NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "scan_jobs_one_open_per_profile" ON "scan_jobs" ("profileId") WHERE "status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "scan_jobs_status_runAfter_index" ON "scan_jobs" ("status","runAfter");--> statement-breakpoint
CREATE INDEX "scan_jobs_profileId_createdAt_index" ON "scan_jobs" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_scoutRunId_scout_runs_id_fkey" FOREIGN KEY ("scoutRunId") REFERENCES "scout_runs"("id") ON DELETE SET NULL;