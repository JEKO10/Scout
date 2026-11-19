import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { InboxCard } from "@/components/inbox/InboxCard";
import { WritePostButton } from "@/components/inbox/WritePostButton";
import { RunScoutButton } from "@/components/watchlist/RunScoutButton";
import { getRecentScoutRuns } from "@/db/queries/scoutRuns";
import { countActiveWatchlist } from "@/db/queries/watchlist";
import { isMissingSchemaError } from "@/db/schemaErrors";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { loadInbox } from "@/services/inbox/inbox";

export const metadata: Metadata = { title: "Home" };

/**
 * Day 38 Home: an assistant's daily briefing. What Scout prepared, one card
 * each, and nothing else above it. Stats and settings live in Overview.
 */
export default function HomePage() {
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
        <Home />
      </Suspense>
    </div>
  );
}

async function Home() {
  const { user, profile } = await requireProfile();
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
        <p className="lede">Your data is safe. <Link href="/dashboard/overview">Open the overview</Link>.</p>
      </main>
    );
  }
  const { items, summary } = inbox;
  const [activeAccounts, [lastRun]] = await Promise.all([countActiveWatchlist(profile.id), getRecentScoutRuns(profile.id, 1)]);
  const lastScan = lastRun?.completedAt ?? null;

  return (
    <main className="workspace shell inbox-home enter-content">
      <header className="inbox-head">
        <h1 className="inbox-title">
          {inbox.greeting}
          {firstName ? `, ${firstName}` : ""}.
        </h1>
        <p className="lede">
          {summary.total === 0
            ? "Nothing needs you right now."
            : `Scout has prepared ${summary.total} ${summary.total === 1 ? "thing" : "things"} for you.`}
        </p>
        {summary.parts.length > 0 && <p className="inbox-summary">{summary.parts.join(" · ")}</p>}
      </header>

      {items.length > 0 ? (
        <section className="inbox-list" aria-label="Prepared for you">
          {items.map((item) => (
            <InboxCard key={`${item.key}:${item.type}`} item={item} />
          ))}
        </section>
      ) : (
        <section className="inbox-empty">
          <p>
            {activeAccounts === 0
              ? "Add a few accounts to watch and Scout will find conversations worth joining."
              : lastScan
                ? `Last scan ${formatRelative(lastScan)}. Scout only shows what's worth your time.`
                : "Scout hasn't scanned yet. Run your first scan to find conversations."}
          </p>
          <div className="inbox-actions">
            {activeAccounts === 0 ? (
              <Link className="primary-button" href="/watchlist">
                Add accounts
              </Link>
            ) : (
              <RunScoutButton disabled={false} />
            )}
            <WritePostButton />
          </div>
        </section>
      )}

      <footer className="inbox-foot">
        {items.length > 0 && <WritePostButton />}
        <Link href="/dashboard/overview" className="text-link">
          See everything <span aria-hidden="true">→</span>
        </Link>
      </footer>
    </main>
  );
}
