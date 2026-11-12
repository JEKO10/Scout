import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { AppHeader } from "@/components/AppHeader";
import { OpportunityCard } from "@/components/opportunities/OpportunityCard";
import { toDrafts } from "@/components/opportunities/toDrafts";
import { getOpportunityForProfile } from "@/db/queries/opportunities";
import { getCurrentReplies, getLastReplyStyles } from "@/db/queries/replies";
import { requireProfile } from "@/lib/auth/session";

// One opportunity, linked from Slack alerts and the notification bell.
export default function OpportunityPage(props: PageProps<"/opportunities/[id]">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense
        fallback={
          <main className="workspace shell" aria-busy="true">
            <div className="skeleton skeleton-title" />
          </main>
        }
      >
        <Opportunity params={props.params} />
      </Suspense>
    </div>
  );
}

async function Opportunity({ params }: { params: PageProps<"/opportunities/[id]">["params"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  // Scoped to the signed-in profile: another user's opportunity is a 404
  const opportunity = await getOpportunityForProfile(profile.id, id);
  if (!opportunity) notFound();

  const [replies, lastStyles] = await Promise.all([
    getCurrentReplies(profile.id, [opportunity.id]),
    getLastReplyStyles(profile.id),
  ]);

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Opportunity</p>
          <h1>Worth joining.</h1>
        </div>
        <Link href="/opportunities" className="secondary-button">
          All opportunities
        </Link>
      </section>
      <div className="opportunity-feed">
        <OpportunityCard
          opportunity={opportunity}
          replies={toDrafts(replies.get(opportunity.id))}
          defaultStyles={lastStyles ?? undefined}
        />
      </div>
    </main>
  );
}
