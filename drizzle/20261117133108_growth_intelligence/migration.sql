CREATE TABLE "account_metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"socialAccountId" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"day" date NOT NULL,
	"capturedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"followers" integer,
	"following" integer,
	"postCount" integer,
	"xPostReads" integer DEFAULT 0 NOT NULL,
	"refreshedAt" timestamp with time zone,
	CONSTRAINT "account_metric_snapshots_socialAccountId_day_unique" UNIQUE("socialAccountId","day")
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "replyToPostId" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "metricsSource" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "metricsFetchedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "unavailableAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "account_metric_snapshots_profileId_day_index" ON "account_metric_snapshots" ("profileId","day");--> statement-breakpoint
ALTER TABLE "account_metric_snapshots" ADD CONSTRAINT "account_metric_snapshots_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_metric_snapshots" ADD CONSTRAINT "account_metric_snapshots_n4m8BPCqrZLn_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE CASCADE;