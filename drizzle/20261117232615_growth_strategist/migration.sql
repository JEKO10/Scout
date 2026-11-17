CREATE TYPE "growth_experiment_status" AS ENUM('proposed', 'active', 'completed', 'stopped');--> statement-breakpoint
CREATE TYPE "growth_strategy_status" AS ENUM('generating', 'active', 'archived', 'failed');--> statement-breakpoint
CREATE TYPE "growth_task_status" AS ENUM('todo', 'done', 'skipped');--> statement-breakpoint
ALTER TYPE "ai_operation" ADD VALUE 'growth_strategy';--> statement-breakpoint
CREATE TABLE "growth_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"strategyId" uuid,
	"title" text NOT NULL,
	"hypothesis" text NOT NULL,
	"dimension" text NOT NULL,
	"variantA" text NOT NULL,
	"variantB" text NOT NULL,
	"metric" text NOT NULL,
	"durationDays" integer NOT NULL,
	"minPerVariant" integer NOT NULL,
	"actions" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "growth_experiment_status" DEFAULT 'proposed'::"growth_experiment_status" NOT NULL,
	"startedAt" timestamp with time zone,
	"endsAt" timestamp with time zone,
	"observations" jsonb DEFAULT '[]' NOT NULL,
	"conclusion" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growth_plan_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"strategyId" uuid NOT NULL,
	"profileId" uuid NOT NULL,
	"day" date NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"activity" text NOT NULL,
	"reason" text NOT NULL,
	"effortMinutes" integer NOT NULL,
	"module" text NOT NULL,
	"evidenceIds" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "growth_task_status" DEFAULT 'todo'::"growth_task_status" NOT NULL,
	"doneAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growth_strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"status" "growth_strategy_status" NOT NULL,
	"mode" text NOT NULL,
	"objective" text NOT NULL,
	"weeklyMinutes" integer NOT NULL,
	"weekStart" date NOT NULL,
	"evidence" jsonb NOT NULL,
	"content" jsonb,
	"evidenceKey" text NOT NULL,
	"model" text,
	"costUsd" double precision,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "growth_experiments_profileId_status_index" ON "growth_experiments" ("profileId","status");--> statement-breakpoint
CREATE INDEX "growth_plan_tasks_strategyId_day_index" ON "growth_plan_tasks" ("strategyId","day");--> statement-breakpoint
CREATE INDEX "growth_plan_tasks_profileId_index" ON "growth_plan_tasks" ("profileId");--> statement-breakpoint
CREATE INDEX "growth_strategies_profileId_createdAt_index" ON "growth_strategies" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "growth_strategies_one_generating" ON "growth_strategies" ("profileId") WHERE "status" = 'generating';--> statement-breakpoint
ALTER TABLE "growth_experiments" ADD CONSTRAINT "growth_experiments_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "growth_experiments" ADD CONSTRAINT "growth_experiments_strategyId_growth_strategies_id_fkey" FOREIGN KEY ("strategyId") REFERENCES "growth_strategies"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "growth_plan_tasks" ADD CONSTRAINT "growth_plan_tasks_strategyId_growth_strategies_id_fkey" FOREIGN KEY ("strategyId") REFERENCES "growth_strategies"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "growth_plan_tasks" ADD CONSTRAINT "growth_plan_tasks_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "growth_strategies" ADD CONSTRAINT "growth_strategies_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;