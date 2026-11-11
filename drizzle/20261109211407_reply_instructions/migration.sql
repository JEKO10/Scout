ALTER TABLE "profiles" ADD COLUMN "replyRules" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "instruction" text;