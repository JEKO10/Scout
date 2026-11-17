ALTER TYPE "ai_operation" ADD VALUE 'trend_insight';--> statement-breakpoint
ALTER TYPE "trend_status" ADD VALUE 'emerging' BEFORE 'rising';--> statement-breakpoint
ALTER TABLE "trends" ADD COLUMN "opportunityScore" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trends" ADD COLUMN "opportunityBreakdown" jsonb;--> statement-breakpoint
ALTER TABLE "trends" ADD COLUMN "timing" text;--> statement-breakpoint
ALTER TABLE "trends" ADD COLUMN "saved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trends" ADD COLUMN "insight" jsonb;--> statement-breakpoint
ALTER TABLE "trends" ADD COLUMN "insightGeneratedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trends" ADD COLUMN "insightBasis" jsonb;--> statement-breakpoint
ALTER TABLE "trends" ADD COLUMN "insightLockedUntil" timestamp with time zone;