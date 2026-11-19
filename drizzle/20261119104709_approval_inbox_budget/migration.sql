CREATE TABLE "inbox_auto_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileId" uuid NOT NULL,
	"month" date NOT NULL,
	"committedUsd" double precision DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_auto_budgets_profileId_month_unique" UNIQUE("profileId","month")
);
--> statement-breakpoint
ALTER TABLE "inbox_auto_budgets" ADD CONSTRAINT "inbox_auto_budgets_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;