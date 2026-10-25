import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { AddWatchlistAccountForm } from "@/components/watchlist/AddWatchlistAccountForm";
import { CandidateLabelList } from "@/components/watchlist/CandidateLabelList";
import { ImportPostsForm } from "@/components/watchlist/ImportPostsForm";
import { RankingCheckView } from "@/components/watchlist/RankingCheckView";
import { RunScoutButton } from "@/components/watchlist/RunScoutButton";
import { ScoutRunSummary } from "@/components/watchlist/ScoutRunSummary";
import { WatchlistList } from "@/components/watchlist/WatchlistList";
import { getRecentCandidates } from "@/db/queries/scoutCandidates";
import { getRecentScoutRuns } from "@/db/queries/scoutRuns";
import { getWatchlist } from "@/db/queries/watchlist";
import { requireProfile } from "@/lib/auth/session";
import { rankingCheck } from "@/services/opportunities/rankingCheck";
import { isUnverified, WATCHLIST_LIMIT } from "@/services/watchlist/addAccount";

const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export default function WatchlistPage() {
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
        <Watchlist />
      </Suspense>
    </div>
  );
}

async function Watchlist() {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");

  const [accounts, runs] = await Promise.all([
    getWatchlist(profile.id),
    getRecentScoutRuns(profile.id),
  ]);
  const activeCount = accounts.filter((account) => account.isActive).length;
  const latestRun = runs[0];
  const candidates = await getRecentCandidates(profile.id);

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Watchlist</p>
          <h1>Who should Scout follow?</h1>
          <p className="lede">
            Add the accounts whose conversations you want to join. Scout only scans
            the active ones.
          </p>
        </div>
      </section>

      <div className="watchlist-layout">
        <section aria-labelledby="watchlist-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{activeCount} active</p>
              <h2 id="watchlist-title">Accounts</h2>
            </div>
            <span className="count-label">
              {accounts.length} / {WATCHLIST_LIMIT}
            </span>
          </div>

          <WatchlistList
            accounts={accounts.map((account) => ({
              ...account,
              unverified: isUnverified(account),
            }))}
          />

          {accounts.length < WATCHLIST_LIMIT ? (
            <AddWatchlistAccountForm />
          ) : (
            <p className="aside-empty">
              Your watchlist is full. Remove an account to add another.
            </p>
          )}

          {candidates.length > 0 && (
            <div className="scout-candidates">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Ranking check</p>
                  <h2>Would you reply?</h2>
                  <p>
                    Label every post before looking at the dashboard, then compare
                    with Scout below.
                  </p>
                </div>
                <span className="count-label">{candidates.length} posts</span>
              </div>
              <CandidateLabelList
                // Only what labeling needs: Scout's scores stay on the server
                candidates={candidates.map(
                  ({ id, authorHandle, url, kind, postedAt, content, userLabel }) => ({
                    id,
                    authorHandle,
                    url,
                    kind,
                    postedAt,
                    content,
                    userLabel,
                  }),
                )}
              />
              <RankingCheckView check={rankingCheck(candidates)} />
            </div>
          )}
        </section>

        <aside className="watchlist-run" aria-label="Run Scout">
          <p className="eyebrow">Scout</p>
          <p className="watchlist-run-copy">
            {activeCount
              ? `Scan ${activeCount} active ${activeCount === 1 ? "account" : "accounts"} for conversations worth joining.`
              : "Add or resume an account to run Scout."}
          </p>
          <RunScoutButton disabled={activeCount === 0} />

          {latestRun && latestRun.status !== "running" && (
            <ScoutRunSummary run={latestRun} />
          )}

          {runs.length > 0 && (
            <ul className="watchlist-runs">
              {runs.map((run) => (
                <li key={run.id}>
                  <span className="run-state" data-status={run.status} />
                  <span>
                    {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                    {run.stats ? ` · ${run.stats.candidates} candidates` : ""}
                  </span>
                  <time dateTime={run.createdAt.toISOString()}>
                    {dateFormat.format(run.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}

          <ImportPostsForm />
        </aside>
      </div>
    </main>
  );
}
