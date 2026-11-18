CREATE TABLE "growth_peers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"platformUserId" text NOT NULL,
	"handle" text NOT NULL,
	"displayName" text,
	"bio" text,
	"followers" integer,
	"following" integer,
	"postCount" integer,
	"accountCreatedAt" timestamp with time zone,
	"source" text NOT NULL,
	"selected" boolean DEFAULT true NOT NULL,
	"lookedUpAt" timestamp with time zone NOT NULL,
	"lastRefreshedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_peers_profileId_platformUserId_unique" UNIQUE("profileId","platformUserId")
);
--> statement-breakpoint
CREATE TABLE "peer_post_stats" (
	"peerId" uuid,
	"platformPostId" text,
	"postedAt" timestamp with time zone NOT NULL,
	"lengthBucket" text NOT NULL,
	"hookType" text NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"likes" integer,
	"replies" integer,
	"reposts" integer,
	"impressions" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "peer_post_stats_pkey" PRIMARY KEY("peerId","platformPostId")
);
--> statement-breakpoint
CREATE TABLE "peer_refreshes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"platformUserId" text NOT NULL,
	"xPostReads" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "growth_strategies" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "growth_strategies" ADD COLUMN "peerMode" text;--> statement-breakpoint
CREATE INDEX "growth_peers_profileId_index" ON "growth_peers" ("profileId");--> statement-breakpoint
CREATE INDEX "peer_post_stats_peerId_postedAt_index" ON "peer_post_stats" ("peerId","postedAt");--> statement-breakpoint
CREATE INDEX "peer_refreshes_profileId_createdAt_index" ON "peer_refreshes" ("profileId","createdAt");--> statement-breakpoint
ALTER TABLE "growth_peers" ADD CONSTRAINT "growth_peers_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "peer_post_stats" ADD CONSTRAINT "peer_post_stats_peerId_growth_peers_id_fkey" FOREIGN KEY ("peerId") REFERENCES "growth_peers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "peer_refreshes" ADD CONSTRAINT "peer_refreshes_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;