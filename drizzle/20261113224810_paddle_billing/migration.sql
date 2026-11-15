ALTER TYPE "plan" ADD VALUE 'starter' BEFORE 'pro';--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"paddleSubscriptionId" text NOT NULL UNIQUE,
	"paddleCustomerId" text NOT NULL,
	"status" text NOT NULL,
	"priceId" text,
	"plan" "plan",
	"currentPeriodEndsAt" timestamp with time zone,
	"scheduledChange" jsonb,
	"lastEventAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paddle_webhook_events" (
	"eventId" text PRIMARY KEY,
	"eventType" text NOT NULL,
	"occurredAt" timestamp with time zone NOT NULL,
	"profileId" uuid,
	"outcome" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "billing_subscriptions_profileId_index" ON "billing_subscriptions" ("profileId");--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "paddle_webhook_events" ADD CONSTRAINT "paddle_webhook_events_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL;