import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { EmptyState } from "@/components/EmptyState";
import { ScoutBrainPanel } from "@/components/ScoutBrainPanel";
import { XAccountCard } from "@/components/XAccountCard";
import { getWorkspaceData } from "@/db/queries/opportunities";
import { countPostsBySocialAccount } from "@/db/queries/posts";
import { getSocialAccountByHandle } from "@/db/queries/socialAccounts";
import { requireProfile } from "@/lib/auth/session";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

const compactNumber = new Intl.NumberFormat("en", { notation: "compact" });
const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export default function DashboardPage() {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard />
      </Suspense>
    </div>
  );
}

async function Dashboard() {
  const { user, profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");

  const [data, xAccount] = await Promise.all([
    getWorkspaceData(profile.id),
    profile.xHandle
      ? getSocialAccountByHandle(profile.id, "x", profile.xHandle)
      : undefined,
  ]);
  const xPostCount = xAccount ? await countPostsBySocialAccount(xAccount.id) : 0;
  const newOpportunities = data.opportunities.filter(
    (opportunity) => opportunity.status === "new",
  ).length;
  const totalImpressions = data.posts.reduce(
    (sum, { post }) => sum + (post.metrics?.impressions ?? 0),
    0,
  );
  const latestRun = data.scoutRuns[0];
  const firstName = (profile.displayName ?? user.name ?? "there").split(" ")[0];

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Your workspace</p>
          <h1>Good to see you, {firstName}.</h1>
          <p className="lede">
            Every relevant conversation and every post, in one calm place.
          </p>
        </div>
        <Link href="/account/settings" className="secondary-button">
          Tune Scout
        </Link>
      </section>

      <section className="metrics-strip" aria-label="Workspace summary">
        <Metric value={data.opportunities.length} label="Opportunities" />
        <Metric value={newOpportunities} label="New matches" />
        <Metric value={data.posts.length} label="Posts analyzed" />
        <Metric
          value={compactNumber.format(totalImpressions)}
          label="Total impressions"
        />
      </section>

      <ScoutBrainPanel
        brain={resolveScoutBrain(profile)}
        postCount={data.posts.length}
      />

      <div className="dashboard-grid">
        <section className="feed-section" aria-labelledby="opportunities-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Ranked by relevance</p>
              <h2 id="opportunities-title">Opportunity feed</h2>
            </div>
            <span className="count-label">{data.opportunities.length} total</span>
          </div>

          {data.opportunities.length ? (
            <div className="opportunity-list">
              {data.opportunities.map((opportunity, index) => (
                <article
                  className="opportunity-row"
                  key={opportunity.id}
                  style={{ "--item-index": index } as React.CSSProperties}
                >
                  <div className="opportunity-meta">
                    <span className="avatar-placeholder" aria-hidden="true">
                      {(opportunity.authorHandle ?? "S").charAt(0).toUpperCase()}
                    </span>
                    <div>
                      <p className="author-name">
                        @{opportunity.authorHandle ?? "unknown"}
                      </p>
                      <p className="metadata-line">
                        {opportunity.platform.toUpperCase()} · {formatDate(opportunity.postedAt)}
                      </p>
                    </div>
                  </div>

                  <div className="opportunity-copy">
                    <p>{opportunity.content}</p>
                    {opportunity.reason && (
                      <p className="match-reason">
                        <span aria-hidden="true">↗</span> {opportunity.reason}
                      </p>
                    )}
                  </div>

                  <div className="opportunity-actions">
                    <span
                      className="status-label"
                      data-status={opportunity.status}
                    >
                      {opportunity.status}
                    </span>
                    <span className="score">
                      <strong>{Math.round(opportunity.score ?? 0)}</strong>
                      <span>match</span>
                    </span>
                    {opportunity.postUrl && (
                      <a
                        href={opportunity.postUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="icon-link"
                        aria-label={`Open post by ${opportunity.authorHandle ?? "author"}`}
                        title="Open original post"
                      >
                        ↗
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No opportunities yet"
              description="Add accounts to your watchlist and run Scout to find conversations worth joining."
              action={{ href: "/account/settings", label: "Set up your sources" }}
            />
          )}
        </section>

        <aside className="dashboard-aside" aria-label="Scout status">
          <XAccountCard
            handle={profile.xHandle}
            account={xAccount}
            postCount={xPostCount}
          />

          <div className="aside-section">
            <p className="eyebrow">Scout status</p>
            <div className="status-line">
              <span
                className="live-dot"
                data-active={latestRun?.status === "completed" || undefined}
              />
              <div>
                <strong>{latestRun ? humanize(latestRun.status) : "Not run yet"}</strong>
                <p>
                  {latestRun
                    ? `${latestRun.opportunitiesFound} matches · ${formatDate(latestRun.completedAt ?? latestRun.createdAt)}`
                    : "Your first scan will appear here."}
                </p>
              </div>
            </div>
          </div>

          <div className="aside-section">
            <div className="aside-heading">
              <p className="eyebrow">Watchlist</p>
              <span>{data.watchlist.length}</span>
            </div>
            {data.watchlist.length ? (
              <ul className="watchlist-preview">
                {data.watchlist.slice(0, 6).map((account) => (
                  <li key={account.id}>
                    <span className="mini-avatar" aria-hidden="true">
                      {account.handle.charAt(0).toUpperCase()}
                    </span>
                    <div>
                      <strong>@{account.handle}</strong>
                      <span>{account.notes ?? humanize(account.platform)}</span>
                    </div>
                    <span
                      className="account-state"
                      data-active={account.isActive || undefined}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="aside-empty">No monitored accounts yet.</p>
            )}
            <Link href="/account/settings" className="text-link">
              Manage data <span aria-hidden="true">→</span>
            </Link>
          </div>
        </aside>
      </div>

      <section className="posts-section" aria-labelledby="posts-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Writing history</p>
            <h2 id="posts-title">All your posts</h2>
          </div>
          <span className="count-label">{data.posts.length} posts</span>
        </div>

        {data.posts.length ? (
          <div className="post-list">
            {data.posts.map(({ post, account }, index) => (
              <article className="post-row" key={post.id}>
                <div className="post-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div className="post-body">
                  <p>{post.content}</p>
                  <div className="post-meta">
                    <span>@{account.handle}</span>
                    <span>{formatDate(post.publishedAt)}</span>
                    <span>{compactNumber.format(post.metrics?.impressions ?? 0)} views</span>
                    <span>{post.metrics?.likes ?? 0} likes</span>
                    <span>{post.metrics?.replies ?? 0} replies</span>
                  </div>
                </div>
                {post.url && (
                  <a
                    href={post.url}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-link"
                    aria-label="Open original post"
                    title="Open original post"
                  >
                    ↗
                  </a>
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No posts connected"
            description="Once your social account is connected and synced, every post will appear here."
            action={{ href: "/account/settings", label: "Review account settings" }}
          />
        )}
      </section>
    </main>
  );
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function formatDate(date: Date | null) {
  return date ? dateFormat.format(date) : "No date";
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function DashboardSkeleton() {
  return (
    <main className="workspace shell" aria-busy="true">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-metrics" />
      <div className="skeleton skeleton-feed" />
    </main>
  );
}
