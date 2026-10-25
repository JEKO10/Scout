CREATE TYPE "reply_variant" AS ENUM('natural', 'stronger_take');--> statement-breakpoint
-- Added nullable first: existing seed replies need values before NOT NULL applies
ALTER TABLE "replies" ADD COLUMN "variant" "reply_variant";--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "originalContent" text;--> statement-breakpoint
UPDATE "replies" SET "variant" = 'natural', "originalContent" = "content" WHERE "variant" IS NULL;--> statement-breakpoint
ALTER TABLE "replies" ALTER COLUMN "variant" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ALTER COLUMN "originalContent" SET NOT NULL;
