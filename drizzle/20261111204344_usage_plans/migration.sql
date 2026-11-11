CREATE TYPE "plan" AS ENUM('free', 'pro', 'internal');--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "plan" "plan" DEFAULT 'free'::"plan" NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "usageLimitOverrides" jsonb;