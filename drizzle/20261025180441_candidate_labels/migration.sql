CREATE TYPE "candidate_label" AS ENUM('yes', 'maybe', 'no');--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "userLabel" "candidate_label";--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "labeledAt" timestamp with time zone;