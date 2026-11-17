CREATE TYPE "lead_activity_kind" AS ENUM('saved', 'status_changed', 'note_added', 'reply_started', 'x_opened', 'contact_logged', 'response_logged', 'follow_up_set', 'follow_up_done', 'new_signal');--> statement-breakpoint
CREATE TYPE "lead_status" AS ENUM('new', 'researching', 'contacted', 'replied', 'qualified', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "lead_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"leadId" uuid NOT NULL,
	"profileId" uuid NOT NULL,
	"kind" "lead_activity_kind" NOT NULL,
	"userEntered" boolean DEFAULT false NOT NULL,
	"detail" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"leadId" uuid NOT NULL,
	"profileId" uuid NOT NULL,
	"body" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status" "lead_status" DEFAULT 'new'::"lead_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "followUpAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "followUpNote" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "followUpDoneAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lastActivityAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "lead_activities_leadId_createdAt_index" ON "lead_activities" ("leadId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "lead_notes_leadId_createdAt_index" ON "lead_notes" ("leadId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_profileId_saved_status_index" ON "leads" ("profileId","saved","status");--> statement-breakpoint
CREATE INDEX "leads_profileId_authorPlatformUserId_index" ON "leads" ("profileId","authorPlatformUserId");--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_leadId_leads_id_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_leadId_leads_id_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_profileId_profiles_id_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE;