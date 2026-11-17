CREATE TYPE "x_connection_status" AS ENUM('active', 'needs_reconnect');--> statement-breakpoint
CREATE TABLE "post_metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"postId" uuid NOT NULL,
	"day" date NOT NULL,
	"capturedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"publicMetrics" jsonb,
	"privateMetrics" jsonb,
	CONSTRAINT "post_metric_snapshots_postId_day_unique" UNIQUE("postId","day")
);
--> statement-breakpoint
CREATE TABLE "x_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL UNIQUE,
	"socialAccountId" uuid NOT NULL,
	"xUserId" text NOT NULL UNIQUE,
	"handle" text NOT NULL,
	"scopes" text NOT NULL,
	"encryptedAccessToken" text NOT NULL,
	"encryptedRefreshToken" text,
	"accessTokenExpiresAt" timestamp with time zone NOT NULL,
	"status" "x_connection_status" DEFAULT 'active'::"x_connection_status" NOT NULL,
	"lastError" text,
	"connectedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"busyUntil" timestamp with time zone,
	"lastCollectedAt" timestamp with time zone,
	"lastAutoCollectedAt" timestamp with time zone,
	"nextCollectionAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "post_metric_snapshots_profileId_day_index" ON "post_metric_snapshots" ("profileId","day");--> statement-breakpoint
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_postId_posts_id_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "x_connections" ADD CONSTRAINT "x_connections_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "x_connections" ADD CONSTRAINT "x_connections_socialAccountId_social_accounts_id_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE CASCADE;