import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { EmptyState } from "@/components/EmptyState";
import { OpportunityCard } from "@/components/opportunities/OpportunityCard";
import { toDraftPair } from "@/components/opportunities/toDraftPair";
import { RunScoutButton } from "@/components/watchlist/RunScoutButton";
import {
  countOpportunitiesByFilter,
  getOpportunities,
  HIGH_SCORE,
  OPPORTUNITY_FILTERS,
  type OpportunityFilter,
} from "@/db/queries/opportunities";
import { getCurrentReplies } from "@/db/queries/replies";
import { getRecentScoutRuns } from "@/db/queries/scoutRuns";
import { getActiveWatchlist } from "@/db/queries/watchlist";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { SURFACE_THRESHOLD } from "@/services/opportunities/score";

const filterLabels: Record<OpportunityFilter, string> = {
  all: "All",
  new: "New",
  saved: "Saved",
  high: `High ${HIGH_SCORE}+`,
  replied: "Replied",
};

export default function OpportunitiesPage(props: PageProps<"/opportunities">) {
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
        <Opportunities searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

async function Opportunities({
  searchParams,
}: {
  searchParams: PageProps<"/opportunities">["searchParams"];
}) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");

  const requested = (await searchParams).filter;
  const filter: OpportunityFilter = OPPORTUNITY_FILTERS.includes(
    requested as OpportunityFilter,
  )
    ? (requested as OpportunityFilter)
    : "new";

  const [opportunities, counts, runs, activeAccounts] = await Promise.all([
    getOpportunities(profile.id, filter),
    countOpportunitiesByFilter(profile.id),
    getRecentScoutRuns(profile.id, 1),
    getActiveWatchlist(profile.id),
  ]);
  const replies = await getCurrentReplies(
    profile.id,
    opportunities.map((opportunity) => opportunity.id),
  );
  const latestRun = runs[0];
  const analyzed = latestRun?.stats?.scoring?.scored ?? 0;

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Opportunity feed</p>
          <h1>Where your time is best spent.</h1>
          <p className="lede">
            {latestRun?.completedAt
              ? `Last scan ${formatRelative(latestRun.completedAt)} · ${analyzed} posts analyzed`
              : "Run Scout to scan your watchlist."}
          </p>
        </div>
        <RunScoutButton disabled={activeAccounts.length === 0} />
      </section>

      <nav className="feed-filters" aria-label="Filter opportunities">
        {OPPORTUNITY_FILTERS.map((option) => (
          <Link
            key={option}
            href={`/opportunities?filter=${option}`}
            className="feed-filter"
            aria-current={option === filter ? "page" : undefined}
          >
            {filterLabels[option]}
            <span>{counts[option]}</span>
          </Link>
        ))}
      </nav>

      {opportunities.length > 0 ? (
        <div className="opportunity-feed">
          {opportunities.map((opportunity) => (
            <OpportunityCard
              key={opportunity.id}
              opportunity={opportunity}
              replies={toDraftPair(replies.get(opportunity.id))}
            />
          ))}
        </div>
      ) : (
        <FeedEmptyState
          filter={filter}
          hasWatchlist={activeAccounts.length > 0}
          hasRun={Boolean(latestRun)}
          analyzed={analyzed}
        />
      )}
    </main>
  );
}

function FeedEmptyState({
  filter,
  hasWatchlist,
  hasRun,
  analyzed,
}: {
  filter: OpportunityFilter;
  hasWatchlist: boolean;
  hasRun: boolean;
  analyzed: number;
}) {
  if (!hasWatchlist) {
    return (
      <EmptyState
        title="Scout isn't watching anyone yet"
        description="Add the accounts whose conversations you want to join, then run Scout."
        action={{ href: "/watchlist", label: "Build your watchlist" }}
      />
    );
  }
  if (!hasRun) {
    return (
      <EmptyState
        title="No scans yet"
        description="Run Scout to scan your watchlist for conversations worth joining."
      />
    );
  }
  if (filter === "saved") {
    return (
      <EmptyState
        title="Nothing saved"
        description="Save an opportunity to come back to it later."
      />
    );
  }
  // Honest by design: Scout never pads the feed with weak matches
  return (
    <EmptyState
      title="No strong opportunities right now."
      description={
        analyzed > 0
          ? `Scout analyzed ${analyzed} posts in the last scan, but none passed your threshold (${filter === "high" ? HIGH_SCORE : SURFACE_THRESHOLD}+).`
          : "The last scan found no new posts to analyze. Import fresh posts or run Scout again later."
      }
      action={{ href: "/watchlist", label: "Review your watchlist" }}
    />
  );
}
