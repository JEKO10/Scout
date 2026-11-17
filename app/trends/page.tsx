import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { EmptyState } from "@/components/EmptyState";
import { TrendBars } from "@/components/trends/TrendBars";
import { getDiscoveryTopics } from "@/db/queries/discovery";
import { getTrends } from "@/db/queries/trends";
import type { Trend } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { OBSERVATION_DAYS } from "@/lib/trends/detect";
import { CONFIDENCE_LABEL, momentumText, STATUS_LABEL, TIMING_LABEL, TIMING_TEXT } from "@/lib/trends/labels";
import { TREND_STATUSES, type TrendStatus } from "@/lib/trends/types";

export const metadata: Metadata = { title: "Trend Scout" };

const RELEVANCE = ["", "50", "70"];
const RECENT = [
  { value: "", label: "Last 7 days" },
  { value: "24", label: "Active in 24 h" },
  { value: "6", label: "Active in 6 h" },
];

export default function TrendsPage({ searchParams }: PageProps<"/trends">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Trends searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

/** The action shown on a card: the AI's when an insight exists, else the timing rule's */
const actionFor = (trend: Trend) => trend.insight?.recommendedAction ?? (trend.timing ? TIMING_TEXT[trend.timing] : null);

async function Trends({ searchParams }: { searchParams: PageProps<"/trends">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

  const topics = await getDiscoveryTopics(profile.id);
  const topicId = topics.some((t) => t.id === one(params.topic)) ? one(params.topic) : "";
  const minRelevance = RELEVANCE.includes(one(params.relevance)) ? one(params.relevance) : "";
  const status = (TREND_STATUSES as readonly string[]).includes(one(params.status)) ? (one(params.status) as TrendStatus) : undefined;
  const recent = RECENT.some((r) => r.value === one(params.recent)) ? one(params.recent) : "";
  const savedOnly = one(params.saved) === "1";
  const compare = one(params.view) === "compare";

  const trends = await getTrends(profile.id, {
    topicId: topicId || undefined,
    minRelevance: minRelevance ? Number(minRelevance) : undefined,
    status,
    recentHours: recent ? Number(recent) : undefined,
    saved: savedOnly,
  });
  const filtered = Boolean(topicId || minRelevance || status || recent || savedOnly);
  const updated = trends.reduce<Date | null>((latest, t) => (!latest || t.updatedAt > latest ? t.updatedAt : latest), null);
  const query = (view: "list" | "compare") => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ topic: topicId, relevance: minRelevance, status: status ?? "", recent, saved: savedOnly ? "1" : "" })) {
      if (value) search.set(key, value);
    }
    if (view === "compare") search.set("view", "compare");
    const text = search.toString();
    return text ? `/trends?${text}` : "/trends";
  };

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Trend Scout</p>
          <h1>What your corner of X is talking about.</h1>
          <p className="lede">
            Topics grouped from the posts your scans collected (watchlist and Smart Discovery), ranked by how worthwhile
            they are for you to join. A sample of your niche, not all of X.
          </p>
        </div>
      </section>

      <form className="discovery-filters" method="get">
        {topics.length > 0 && (
          <label>
            Discovery topic
            <select name="topic" defaultValue={topicId}>
              <option value="">All sources</option>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Relevance
          <select name="relevance" defaultValue={minRelevance}>
            <option value="">Any</option>
            <option value="50">50+</option>
            <option value="70">70+</option>
          </select>
        </label>
        <label>
          Momentum
          <select name="status" defaultValue={status ?? ""}>
            <option value="">Any</option>
            {TREND_STATUSES.map((option) => (
              <option key={option} value={option}>
                {STATUS_LABEL[option]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Recency
          <select name="recent" defaultValue={recent}>
            {RECENT.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Show
          <select name="saved" defaultValue={savedOnly ? "1" : ""}>
            <option value="">All trends</option>
            <option value="1">Saved</option>
          </select>
        </label>
        {compare && <input type="hidden" name="view" value="compare" />}
        <button type="submit" className="secondary-button">
          Filter
        </button>
        {filtered && (
          <Link href={compare ? "/trends?view=compare" : "/trends"} className="text-link">
            Clear
          </Link>
        )}
        <span className="crm-view-toggle" role="group" aria-label="View">
          <Link href={query("list")} aria-current={compare ? undefined : "page"}>
            Trends
          </Link>
          <Link href={query("compare")} aria-current={compare ? "page" : undefined}>
            Compare
          </Link>
        </span>
      </form>
      <p className="memory-note">
        Updated after each scan{updated ? ` · last ${formatRelative(updated)}` : ""} · observation period: last {OBSERVATION_DAYS} days ·
        momentum compares equal 24-hour windows only when your scans covered both.
      </p>

      {trends.length === 0 ? (
        <EmptyState
          title={filtered ? "No trends match these filters." : "No trends yet."}
          description={
            filtered
              ? "Try another filter."
              : "Trends need at least 3 related posts from 2 different accounts in your recent scans. Run a few scans, or add Smart Discovery topics to see more of your niche."
          }
          action={{ href: "/discovery", label: "Smart Discovery" }}
        />
      ) : compare ? (
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Trend</th>
                <th title="How worthwhile it is for you to take part">Opportunity</th>
                <th title="How closely it matches your expertise">Relevance</th>
                <th title="Observed growth, only with comparable history">Momentum</th>
                <th>Confidence</th>
                <th>Posts</th>
                <th>Timing</th>
              </tr>
            </thead>
            <tbody>
              {trends.map((trend) => (
                <tr key={trend.id}>
                  <td>
                    <Link href={`/trends/${trend.id}`}>{trend.label}</Link>
                  </td>
                  <td>{trend.opportunityScore}</td>
                  <td>{trend.relevance}</td>
                  <td>{STATUS_LABEL[trend.status]}</td>
                  <td>{CONFIDENCE_LABEL[trend.confidence]}</td>
                  <td>
                    {trend.postCount} · {trend.authorCount} accounts
                  </td>
                  <td>{trend.timing ? TIMING_LABEL[trend.timing] : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="memory-note">Best first: the top row is the one worth your attention first. Scores aren&apos;t predictions of reach.</p>
        </div>
      ) : (
        <div className="trend-list">
          {trends.map((trend) => (
            <article key={trend.id} className="trend-card">
              <div className="trend-meta">
                <span className="trend-status" data-status={trend.status}>
                  {STATUS_LABEL[trend.status]}
                </span>
                {trend.timing && (
                  <span className="trend-timing" data-timing={trend.timing}>
                    {TIMING_LABEL[trend.timing]}
                  </span>
                )}
                <span>Opportunity {trend.opportunityScore}/100</span>
                <span>Relevance {trend.relevance}/100</span>
                <span>{CONFIDENCE_LABEL[trend.confidence]}</span>
                {trend.saved && <span>Saved</span>}
              </div>
              <h2>
                <Link href={`/trends/${trend.id}`}>{trend.label}</Link>
              </h2>
              <p>
                {trend.insight ? (
                  <>
                    <span className="ai-tag">AI</span> {trend.insight.summary}
                  </>
                ) : (
                  trend.summary
                )}
              </p>
              <p>{momentumText(trend.momentum)}</p>
              <TrendBars counts={trend.dailyCounts} />
              {actionFor(trend) && (
                <p className="trend-action">
                  <strong>Recommended:</strong> {actionFor(trend)}
                </p>
              )}
              <div className="trend-meta">
                <span>
                  {trend.postCount} posts · {trend.authorCount} accounts
                </span>
                <span>Latest post {formatRelative(trend.lastPostAt)}</span>
                <span>Updated {formatRelative(trend.updatedAt)}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
