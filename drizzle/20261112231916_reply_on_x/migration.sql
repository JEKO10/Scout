CREATE TYPE "reply_intent_source" AS ENUM('x_web_intent', 'clipboard');--> statement-breakpoint
CREATE TYPE "reply_intent_status" AS ENUM('opened', 'confirmed', 'returned');--> statement-breakpoint
ALTER TYPE "opportunity_status" ADD VALUE 'reply_opened';--> statement-breakpoint
CREATE TABLE "reply_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"opportunityId" uuid NOT NULL UNIQUE,
	"replyId" uuid,
	"platformPostId" text NOT NULL,
	"text" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"source" "reply_intent_source" NOT NULL,
	"status" "reply_intent_status" DEFAULT 'opened'::"reply_intent_status" NOT NULL,
	"previousStatus" "opportunity_status" NOT NULL,
	"openCount" integer DEFAULT 1 NOT NULL,
	"openedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmedAt" timestamp with time zone,
	"returnedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reply_intents_profileId_openedAt_index" ON "reply_intents" ("profileId","openedAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "reply_intents" ADD CONSTRAINT "reply_intents_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reply_intents" ADD CONSTRAINT "reply_intents_opportunityId_opportunities_id_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reply_intents" ADD CONSTRAINT "reply_intents_replyId_replies_id_fkey" FOREIGN KEY ("replyId") REFERENCES "replies"("id") ON DELETE SET NULL;