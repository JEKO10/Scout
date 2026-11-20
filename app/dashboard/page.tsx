import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { InboxCard } from "@/components/inbox/InboxCard";
import { SummaryChip } from "@/components/inbox/SummaryChip";
import { WritePostButton } from "@/components/inbox/WritePostButton";
import { RunScoutButton } from "@/components/watchlist/RunScoutButton";
import { getRecentScoutRuns } from "@/db/queries/scoutRuns";
import { countActiveWatchlist } from "@/db/queries/watchlist";
import { isMissingSchemaError } from "@/db/schemaErrors";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { summaryChips } from "@/lib/inbox/cards";
import { loadInbox } from "@/services/inbox/inbox";
import { getXConnectionOverview } from "@/services/x/oauthConnection";

export const metadata: Metadata = { title: "Home" };

/**
 * Home: an assistant's daily briefing. A greeting, what Scout prepared
 * (counted, never written by AI), and one card per piece of work. Stats
 * and settings live in Overview.
 */
export default function HomePage({ searchParams }: PageProps<"/dashboard">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense
        fallback={
          <main className="workspace shell inbox-home" aria-busy="true">
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-feed" />
          </main>
        }
      >
        <Home searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

/** After "Enable X publishing": what X granted (the approved post waits below) */
const RETURN_MESSAGE: Record<string, { ok: boolean; text: string }> = {
  publishing_enabled: { ok: true, text: "X publishing enabled. Scout publishes only the posts you approve." },
  publish_not_granted: { ok: false, text: "X didn't allow publishing. Your post is still approved: try again, or copy it to X." },
  cancelled: { ok: false, text: "Nothing changed on X. Your post is still approved." },
};

async function Home({ searchParams }: { searchParams: PageProps<"/dashboard">["searchParams"] }) {
  const { user, profile } = await requireProfile();
  const params = await searchParams;
  const returned = typeof params.x === "string" ? RETURN_MESSAGE[params.x] : undefined;
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const firstName = (profile.displayName ?? user.name ?? "").split(" ")[0];

  let inbox: Awaited<ReturnType<typeof loadInbox>>;
  try {
    inbox = await loadInbox(profile);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    console.error("Home inbox is unavailable: the database is missing migration 'approval_inbox'.");
    return (
      <main className="workspace shell inbox-home enter-content">
        <h1 className="inbox-title">Home needs a database update.</h1>
        <p className="inbox-lede">
          Your data is safe. <Link href="/dashboard/overview">Open the overview</Link>.
        </p>
      </main>
    );
  }
  const { items, summary } = inbox;
  const chips = summaryChips(items);

  return (
    <main className="workspace shell inbox-home enter-content">
      <header className="inbox-head">
        <h1 className="inbox-title">
          {inbox.greeting}
          {firstName ? `, ${firstName}` : ""}. <span aria-hidden="true">👋</span>
        </h1>
        <p className="inbox-lede">
          {summary.total === 0
            ? "Nothing needs your attention right now."
            : `Scout has prepared ${summary.total} ${summary.total === 1 ? "thing" : "things"} for you today.`}
        </p>
        {chips.length > 0 && (
          <ul className="inbox-chip-row" aria-label="Prepared for you">
            {chips.map((chip) => (
              <SummaryChip key={chip.type} type={chip.type} label={chip.label} />
            ))}
          </ul>
        )}
      </header>

      {returned && (
        <p className="form-message" data-status={returned.ok ? "success" : "error"} role="status">
          {returned.text}
        </p>
      )}
      {items.length > 0 ? (
        <section className="inbox-list" aria-label="Ready for your decision">
          {items.map((item) => (
            <InboxCard key={`${item.key}:${item.type}`} item={item} />
          ))}
        </section>
      ) : (
        <EmptyHome profileId={profile.id} profile={profile} />
      )}

      <footer className="inbox-foot">
        {items.length > 0 && !items.some((i) => i.type === "post") && <WritePostButton quiet />}
        <Link href="/dashboard/overview" className="text-link">
          See everything <span aria-hidden="true">→</span>
        </Link>
      </footer>
    </main>
  );
}

/** Honest: only actions that are available now, and no claim that a scan happened when it didn't */
async function EmptyHome({ profileId, profile }: { profileId: string; profile: Awaited<ReturnType<typeof requireProfile>>["profile"] }) {
  const [activeAccounts, [lastRun], x] = await Promise.all([countActiveWatchlist(profileId), getRecentScoutRuns(profileId, 1), getXConnectionOverview(profile)]);
  const lastScan = lastRun?.completedAt ?? null;
  return (
    <section className="inbox-empty">
      <p className="inbox-empty-title">Scout will show relevant conversations and prepared work here.</p>
      <p className="inbox-why">
        {activeAccounts === 0
          ? "Add a few accounts to watch and Scout will find conversations worth joining."
          : lastScan
            ? `Last scan ${formatRelative(lastScan)}. Scout only shows what's worth your time.`
            : "Scout hasn't scanned yet."}
      </p>
      <div className="inbox-empty-actions">
        {activeAccounts === 0 ? (
          <Link className="primary-button" href="/watchlist">
            Add accounts
          </Link>
        ) : (
          <RunScoutButton disabled={false} />
        )}
        <WritePostButton />
        {x.enabled && !x.connection && (
          <a className="secondary-button" href="/api/x/oauth/start">
            Connect X
          </a>
        )}
      </div>
    </section>
  );
}
