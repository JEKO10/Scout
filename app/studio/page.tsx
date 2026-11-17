import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { AppHeader } from "@/components/AppHeader";
import { CreateContent } from "@/components/content/CreateContent";
import { EmptyState } from "@/components/EmptyState";
import { getDrafts, getTrendsForContent } from "@/db/queries/content";
import { getTrend } from "@/db/queries/trends";
import type { Profile } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";
import { isValidTimeZone } from "@/lib/content/calendar";
import { CONTENT_REPLY_GENERATIONS_HINT } from "@/lib/content/hints";
import { type ContentGoal, DRAFT_STATUSES,type DraftStatus } from "@/lib/content/types";
import { formatRelative } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/trends/labels";

export const metadata: Metadata = { title: "Content Studio" };

/** A sensible default goal from what the user told Scout in onboarding */
function defaultGoal(profile: Profile): ContentGoal {
  const goal = (profile.primaryGoal ?? "").toLowerCase();
  if (goal.includes("customer") || goal.includes("lead")) return "generate_leads";
  if (goal.includes("authority") || goal.includes("known")) return "build_authority";
  if (goal.includes("network") || goal.includes("conversation")) return "start_conversations";
  if (goal.includes("product") || goal.includes("traffic")) return "promote_product";
  return "grow_audience";
}

export default function StudioPage({ searchParams }: PageProps<"/studio">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Studio searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Studio({ searchParams }: { searchParams: PageProps<"/studio">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

  const trendParam = one(params.trend);
  const trend = z.uuid().safeParse(trendParam).success ? await getTrend(profile.id, trendParam) : undefined;
  const planDate = /^\d{4}-\d{2}-\d{2}$/.test(one(params.plan)) ? one(params.plan) : null;
  const plan = planDate ? { date: planDate, timeZone: isValidTimeZone(one(params.tz)) ? one(params.tz) : "UTC" } : null;
  const q = one(params.q).trim().slice(0, 80);
  const status = (DRAFT_STATUSES as readonly string[]).includes(one(params.status)) ? (one(params.status) as DraftStatus) : undefined;

  const [drafts, trends] = await Promise.all([getDrafts(profile.id, { q: q || undefined, status }), getTrendsForContent(profile.id)]);
  const filtered = Boolean(q || status);

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Content Studio</p>
          <h1>Write posts that sound like you.</h1>
          <p className="lede">
            Ideas and drafts from your Scout Brain, your trends and your customers&apos; recurring problems. You edit, you
            post. Scout never publishes anything.
          </p>
        </div>
      </section>

      <div className="discovery-layout">
        <div>
          <CreateContent defaultGoal={defaultGoal(profile)} trend={trend ? { id: trend.id, label: trend.label } : null} plan={plan} />
          <p className="memory-note">{CONTENT_REPLY_GENERATIONS_HINT}</p>

          {trends.length > 0 && (
            <section className="crm-panel" aria-labelledby="inspiration-title">
              <h2 id="inspiration-title">Inspiration from your trends</h2>
              <ul className="crm-notes">
                {trends.map((item) => (
                  <li key={item.id}>
                    <p>
                      <strong>{item.label}</strong> · {STATUS_LABEL[item.status]} · relevance {item.relevance}
                      {item.saved && " · saved"}
                    </p>
                    <Link href={`/studio?trend=${item.id}`} className="text-link">
                      Create content from this trend →
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <section aria-labelledby="drafts-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Most recent first</p>
              <h2 id="drafts-title">Your drafts</h2>
            </div>
          </div>
          <form className="discovery-filters" method="get">
            <label>
              Search
              <input name="q" defaultValue={q} className="crm-search" placeholder="Title or text" />
            </label>
            <label>
              Status
              <select name="status" defaultValue={status ?? ""}>
                <option value="">All</option>
                <option value="draft">Draft</option>
                <option value="ready">Ready</option>
              </select>
            </label>
            {trend && <input type="hidden" name="trend" value={trend.id} />}
            <button type="submit" className="secondary-button">
              Apply
            </button>
            {filtered && (
              <Link href="/studio" className="text-link">
                Clear
              </Link>
            )}
          </form>

          {drafts.length === 0 ? (
            <EmptyState
              title={filtered ? "No drafts match." : "No drafts yet."}
              description={filtered ? "Try another search." : "Create your first post or thread on the left. Drafts are saved here automatically."}
              action={{ href: "/trends", label: "Browse your trends" }}
            />
          ) : (
            <div className="trend-list">
              {drafts.map((draft) => (
                <article key={draft.id} className="trend-card">
                  <div className="trend-meta">
                    <span className="trend-status" data-status={draft.status === "ready" ? "rising" : "stable"}>
                      {draft.status === "ready" ? "Ready" : "Draft"}
                    </span>
                    <span>{draft.format === "thread" ? `Thread · ${draft.posts.length} posts` : "Post"}</span>
                    {draft.publishedConfirmedAt && <span>You marked it posted</span>}
                    {draft.plannedAt && !draft.publishedConfirmedAt && <span>Planned {formatRelative(draft.plannedAt)}</span>}
                    <span>Edited {formatRelative(draft.updatedAt)}</span>
                  </div>
                  <h2>
                    <Link href={`/studio/${draft.id}`}>{draft.title}</Link>
                  </h2>
                  <p>{draft.posts[0]?.slice(0, 180)}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
