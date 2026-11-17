import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AiCostPanel } from "@/components/AiCostPanel";
import { AppHeader } from "@/components/AppHeader";
import { EmptyState } from "@/components/EmptyState";
import { InfoHint } from "@/components/InfoHint";
import { MissedPosts } from "@/components/missed/MissedPosts";
import { ScoutBrainPanel } from "@/components/ScoutBrainPanel";
import { RunScoutButton } from "@/components/watchlist/RunScoutButton";
import { XAccountCard } from "@/components/XAccountCard";
import { XTestingPanel } from "@/components/XTestingPanel";
import { getWorkspaceData } from "@/db/queries/opportunities";
import { countPostsBySocialAccount } from "@/db/queries/posts";
import { getPostedReplies } from "@/db/queries/replies";
import { getSocialAccountByHandle } from "@/db/queries/socialAccounts";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { getAiCostSummary } from "@/services/ai/costSummary";
import { buildUserMemory } from "@/services/memory/buildUserMemory";
import { opportunityTier } from "@/services/opportunities/score";
import { getScoutTestStatus } from "@/services/scout/testStatus";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { teachPrompts } from "@/services/scout-brain/teachPrompts";

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
  // X testing limits and AI costs are developer panels: internal accounts only
  const internal = profile.plan === "internal";
  const [voiceSamples, memory, testStatus, aiCost, postedReplies] = await Promise.all([
    getVoiceSamples(profile.id),
    buildUserMemory(profile.id),
    internal ? getScoutTestStatus(profile.id) : null,
    internal ? getAiCostSummary(profile.id) : null,
    getPostedReplies(profile.id, 20),
  ]);
  const calibration = voiceSamples.filter((sample) => sample.source === "onboarding");
  const opinions = voiceSamples.filter((sample) => sample.source === "opinion");
  const brain = resolveScoutBrain(profile);
  // getWorkspaceData sorts by score, so these are the best open ones
  const topOpportunities = data.opportunities
    .filter((opportunity) => opportunity.status === "new")
    .slice(0, 5);
  const activeAccounts = data.watchlist.filter((account) => account.isActive).length;
  const firstName = (profile.displayName ?? user.name ?? "there").split(" ")[0];

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <h1>Welcome back, {firstName}</h1>
          <p className="lede">
            {newOpportunities
              ? `${newOpportunities} new ${newOpportunities === 1 ? "opportunity is" : "opportunities are"} waiting for you.`
              : "Here's what's happening with your growth."}
          </p>
        </div>
        <div className="workspace-actions">
          <Link href="/account/settings" className="secondary-button">
            Tune Scout
          </Link>
          <RunScoutButton disabled={activeAccounts === 0} />
        </div>
      </section>

      <section className="stat-cards" aria-label="Workspace summary">
        <StatCard icon="target" value={newOpportunities} label="New opportunities" href="/opportunities" />
        <StatCard icon="eye" value={activeAccounts} label="Watched accounts" href="/watchlist" />
        <StatCard icon="doc" value={data.posts.length} label="Your posts analyzed" />
        <StatCard icon="chart" value={compactNumber.format(totalImpressions)} label="Impressions" href="/growth" />
      </section>

      <div className="dashboard-grid">
        <section className="dash-card" aria-labelledby="opportunities-title">
          <div className="dash-card-head">
            <div className="title-with-hint">
              <h2 id="opportunities-title">Today&apos;s opportunities</h2>
              <InfoHint label="How scores work">
                Scores run from 0 to 100: how well a post fits your topics, goals and expertise, how fresh it is and
                whether a reply from you would add something. Higher is worth your time sooner.
              </InfoHint>
            </div>
            <Link href="/opportunities" className="text-link">
              View all <span aria-hidden="true">→</span>
            </Link>
          </div>

          {topOpportunities.length ? (
            <ul className="opportunity-list">
              {topOpportunities.map((opportunity) => {
                const score = Math.round(opportunity.score ?? 0);
                return (
                  <li key={opportunity.id}>
                    <Link href={`/opportunities/${opportunity.id}`}>
                      <span className="mini-avatar" aria-hidden="true">
                        {(opportunity.authorHandle ?? "?").charAt(0).toUpperCase()}
                      </span>
                      <span className="opportunity-list-text">
                        <span className="opportunity-list-meta">
                          {opportunity.authorHandle ? `@${opportunity.authorHandle}` : "Unknown author"}
                          {opportunity.postedAt && ` · ${formatRelative(opportunity.postedAt)}`}
                        </span>
                        <span className="opportunity-list-post">{opportunity.content}</span>
                      </span>
                      <span className="score-badge" data-tier={opportunityTier(score)} title="Opportunity score">
                        {score}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              title="No strong opportunities right now."
              description={
                activeAccounts
                  ? `Scout only surfaces posts worth your time. Run Scout to scan your ${activeAccounts} watched accounts again.`
                  : "Add accounts to your watchlist and run Scout to find conversations worth joining."
              }
              action={{ href: "/watchlist", label: activeAccounts ? "Review your watchlist" : "Build your watchlist" }}
            />
          )}
        </section>

        <aside className="dashboard-aside" aria-label="Scout status">
          {testStatus && <XTestingPanel status={testStatus} />}
          {aiCost && <AiCostPanel summary={aiCost} />}
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
                {data.watchlist.slice(0, 5).map((account) => (
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
            <Link href="/watchlist" className="text-link">
              Manage watchlist <span aria-hidden="true">→</span>
            </Link>
          </div>
        </aside>
      </div>

      {/* Day 21: rate a few posts Scout didn't surface; its own boundary, never blocks the page */}
      <Suspense fallback={null}>
        <MissedPosts profile={profile} />
      </Suspense>

      <ScoutBrainPanel
        brain={brain}
        postCount={data.posts.length}
        sampleCount={calibration.length}
        teach={
          brain?.basis === "onboarding"
            ? {
                prompts: teachPrompts(
                  brain,
                  opinions.map((sample) => sample.promptPost),
                ),
                opinions: opinions.map((sample) => ({
                  id: sample.id,
                  prompt: sample.promptPost,
                  text: sample.userReply,
                })),
                calibrationCount: calibration.length,
                postedCount: postedReplies.length,
              }
            : undefined
        }
        interactionCount={memory.interactionCount}
      />

      <section className="dash-card posts-section" aria-labelledby="posts-title">
        <div className="dash-card-head">
          <h2 id="posts-title">Your recent posts</h2>
          <span className="count-label">{data.posts.length} posts</span>
        </div>

        {data.posts.length ? (
          <>
            <PostList posts={data.posts.slice(0, 5)} />
            {data.posts.length > 5 && (
              <details className="more-list">
                <summary>Show all {data.posts.length} posts</summary>
                <PostList posts={data.posts.slice(5)} />
              </details>
            )}
          </>
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

function PostList({ posts }: { posts: Awaited<ReturnType<typeof getWorkspaceData>>["posts"] }) {
  return (
    <div className="post-list">
      {posts.map(({ post, account }) => (
        <article className="post-row" key={post.id}>
          <div className="post-body">
            <p>{post.content}</p>
            <div className="post-meta">
              <span>@{account.handle}</span>
              <span>{formatDate(post.publishedAt)}</span>
              {post.metrics?.impressions != null && <span>{compactNumber.format(post.metrics.impressions)} views</span>}
              {post.metrics?.likes != null && <span>{post.metrics.likes} likes</span>}
              {post.metrics?.replies != null && <span>{post.metrics.replies} replies</span>}
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
  );
}

const statIcons = {
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  doc: <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
};

function StatCard({
  icon,
  value,
  label,
  href,
}: {
  icon: keyof typeof statIcons;
  value: string | number;
  label: string;
  href?: string;
}) {
  const body = (
    <>
      <span className="stat-card-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {statIcons[icon]}
        </svg>
      </span>
      <span className="stat-card-label">{label}</span>
      <strong>{value}</strong>
    </>
  );
  return href ? (
    <Link href={href} className="stat-card">
      {body}
    </Link>
  ) : (
    <div className="stat-card">{body}</div>
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
