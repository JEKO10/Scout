CREATE TYPE "miss_rating" AS ENUM('strong', 'acceptable', 'weak', 'not_for_me');--> statement-breakpoint
CREATE TYPE "miss_sample" AS ENUM('near_threshold', 'random_low');--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "missRating" "miss_rating";--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "missSample" "miss_sample";--> statement-breakpoint
ALTER TABLE "scout_candidates" ADD COLUMN "missRatedAt" timestamp with time zone;