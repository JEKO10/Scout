CREATE TABLE "x_api_usage" (
	"day" date PRIMARY KEY,
	"requests" integer DEFAULT 0 NOT NULL,
	"failedRequests" integer DEFAULT 0 NOT NULL,
	"retriedRequests" integer DEFAULT 0 NOT NULL,
	"postsReturned" integer DEFAULT 0 NOT NULL,
	"postsAccepted" integer DEFAULT 0 NOT NULL,
	"runsCompleted" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watchlist_accounts" ADD COLUMN "xCursor" jsonb;