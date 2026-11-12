CREATE TYPE "notification_channel" AS ENUM('slack');--> statement-breakpoint
CREATE TYPE "notification_delivery_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "slack_connection_status" AS ENUM('active', 'needs_reconnect', 'channel_unavailable');--> statement-breakpoint
CREATE TABLE "notification_daily_counts" (
	"profileId" uuid,
	"channel" "notification_channel",
	"day" date,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "notification_daily_counts_pkey" PRIMARY KEY("profileId","channel","day")
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"notificationId" uuid NOT NULL,
	"profileId" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending'::"notification_delivery_status" NOT NULL,
	"reason" text,
	"day" date NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"runAfter" timestamp with time zone DEFAULT now() NOT NULL,
	"lockedBy" text,
	"lockedUntil" timestamp with time zone,
	"providerMessageId" text,
	"error" text,
	"sentAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_notificationId_channel_unique" UNIQUE("notificationId","channel")
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"profileId" uuid PRIMARY KEY,
	"slackEnabled" boolean DEFAULT false NOT NULL,
	"minScore" integer DEFAULT 80 NOT NULL,
	"maxPerDay" integer DEFAULT 5 NOT NULL,
	"quietHoursStart" integer,
	"quietHoursEnd" integer,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"opportunityId" uuid NOT NULL UNIQUE,
	"readAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL UNIQUE,
	"teamId" text NOT NULL,
	"teamName" text NOT NULL,
	"botUserId" text,
	"scopes" text NOT NULL,
	"encryptedBotToken" text NOT NULL,
	"channelId" text,
	"channelName" text,
	"status" "slack_connection_status" DEFAULT 'active'::"slack_connection_status" NOT NULL,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notification_deliveries_status_runAfter_index" ON "notification_deliveries" ("status","runAfter");--> statement-breakpoint
CREATE INDEX "notification_deliveries_profileId_createdAt_index" ON "notification_deliveries" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_profileId_createdAt_index" ON "notifications" ("profileId","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notification_daily_counts" ADD CONSTRAINT "notification_daily_counts_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_notifications_id_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_opportunityId_opportunities_id_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;