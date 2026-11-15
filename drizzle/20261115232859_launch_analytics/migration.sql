CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"profileId" uuid,
	"once" boolean DEFAULT false NOT NULL,
	"props" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "analytics_events_name_createdAt_index" ON "analytics_events" ("name","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_events_once_per_profile" ON "analytics_events" ("name","profileId") WHERE "once";--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL;