CREATE TYPE "eval_case_category" AS ENUM('very_relevant', 'somewhat_relevant', 'knows_little_to_add', 'irrelevant');--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"authorHandle" text NOT NULL,
	"content" text NOT NULL,
	"category" "eval_case_category" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"runId" uuid NOT NULL,
	"caseId" uuid NOT NULL,
	"decision" jsonb NOT NULL,
	"reply" text NOT NULL,
	"contextPostIds" jsonb NOT NULL,
	"voiceScore" integer,
	"wouldPost" boolean,
	"tooGeneric" boolean,
	"decisionCorrect" boolean,
	"notes" text,
	"ratedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_results_runId_caseId_unique" UNIQUE("runId","caseId")
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"brainAnalyzedAt" timestamp with time zone NOT NULL,
	"model" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "eval_cases_profileId_createdAt_index" ON "eval_cases" ("profileId","createdAt");--> statement-breakpoint
CREATE INDEX "eval_runs_profileId_createdAt_index" ON "eval_runs" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_runId_eval_runs_id_fkey" FOREIGN KEY ("runId") REFERENCES "eval_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_caseId_eval_cases_id_fkey" FOREIGN KEY ("caseId") REFERENCES "eval_cases"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;