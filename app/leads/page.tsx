import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { EmptyState } from "@/components/EmptyState";
import { IcpForm } from "@/components/leads/IcpForm";
import { LeadCard } from "@/components/leads/LeadCard";
import { getDiscoveryTopics } from "@/db/queries/discovery";
import { getLeadCounts, getLeads } from "@/db/queries/leads";
import { requireProfile } from "@/lib/auth/session";
import { effectiveLimits } from "@/lib/billing/plans";
import { formatRelative } from "@/lib/format";
import { LEAD_INTENTS, type LeadIntent } from "@/lib/leads/types";

export const metadata: Metadata = { title: "Lead Scout" };

const SCORE_FILTERS = ["", "50", "70"];
const RECENT_FILTERS = [
  { value: "", label: "Best first" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
];

export default function LeadsPage({ searchParams }: PageProps<"/leads">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Leads searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Leads({ searchParams }: { searchParams: PageProps<"/leads">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

  const topics = await getDiscoveryTopics(profile.id);
  // Only known values and the user's own topics are accepted as filters
  const intent = (LEAD_INTENTS as readonly string[]).includes(one(params.intent)) ? (one(params.intent) as LeadIntent) : undefined;
  const minScore = SCORE_FILTERS.includes(one(params.score)) ? one(params.score) : "";
  const days = RECENT_FILTERS.some((f) => f.value === one(params.days)) ? one(params.days) : "";
  const topicId = topics.some((t) => t.id === one(params.topic)) ? one(params.topic) : "";
  const savedOnly = one(params.saved) === "1";

  const [leads, counts] = await Promise.all([
    getLeads(profile.id, {
      intent,
      minScore: minScore ? Number(minScore) : undefined,
      sinceDays: days ? Number(days) : undefined,
      topicId: topicId || undefined,
      saved: savedOnly,
    }),
    getLeadCounts(profile.id),
  ]);
  const topicNames = new Map(topics.map((t) => [t.id, t.name]));
  const filtered = Boolean(intent || minScore || days || topicId || savedOnly);
  const checksPerScan = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxLeadChecksPerRun;

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Lead Scout</p>
          <h1>People who may need what you offer.</h1>
          <p className="lede">
            Scout checks the most relevant posts from your scans (watchlist and Smart Discovery) for buying intent, and
            shows the evidence. You decide whether and how to engage.
          </p>
        </div>
      </section>

      <div className="discovery-layout">
        <section aria-labelledby="icp-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your ideal customer</p>
              <h2 id="icp-title">Customer profile</h2>
            </div>
          </div>
          <IcpForm initial={profile.leadProfile} />
          <p className="memory-note">
            Up to {checksPerScan} posts per scan are checked, the most relevant first, from the same AI budget as
            scoring. Each post is checked once.
          </p>
        </section>

        <section aria-labelledby="leads-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {counts.total} found · {counts.high} high intent · {counts.saved} saved
              </p>
              <h2 id="leads-title">Leads</h2>
            </div>
          </div>

          <form className="discovery-filters" method="get">
            <label>
              Intent
              <select name="intent" defaultValue={intent ?? ""}>
                <option value="">Any intent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label>
              Score
              <select name="score" defaultValue={minScore}>
                <option value="">Any score</option>
                <option value="50">50+</option>
                <option value="70">70+</option>
              </select>
            </label>
            <label>
              Order
              <select name="days" defaultValue={days}>
                {RECENT_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {topics.length > 0 && (
              <label>
                Topic
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
              Show
              <select name="saved" defaultValue={savedOnly ? "1" : ""}>
                <option value="">All leads</option>
                <option value="1">Saved</option>
              </select>
            </label>
            <button type="submit" className="secondary-button">
              Filter
            </button>
            {filtered && (
              <Link href="/leads" className="text-link">
                Clear
              </Link>
            )}
          </form>

          {leads.length ? (
            <div className="opportunity-feed">
              {leads.map((lead) => (
                <LeadCard
                  key={lead.id}
                  lead={{
                    id: lead.id,
                    authorHandle: lead.authorHandle,
                    postUrl: lead.postUrl,
                    content: lead.content,
                    postedLabel: formatRelative(lead.postedAt),
                    foundLabel: formatRelative(lead.createdAt),
                    intent: lead.intent,
                    score: lead.score,
                    breakdown: lead.scoreBreakdown,
                    evidence: lead.evidence,
                    reason: lead.reason,
                    suggestedAction: lead.suggestedAction,
                    saved: lead.saved,
                    topicName: lead.discoveryTopicId ? (topicNames.get(lead.discoveryTopicId) ?? null) : null,
                  }}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title={filtered ? "No leads match these filters." : "No leads yet."}
              description={
                filtered
                  ? "Try another intent, a lower score or all sources."
                  : profile.leadProfile
                    ? "Leads appear after your next scans, when someone's post shows a need for what you offer. Smart Discovery topics about your customers' problems help most."
                    : "Save your customer profile first. Scout then checks relevant posts from your scans for buying intent."
              }
              action={{ href: "/discovery", label: "Set up Smart Discovery" }}
            />
          )}
          <p className="memory-note">
            Lead scores rank posts by customer fit, intent, problem fit, evidence and recency. They aren&apos;t a chance
            of buying. Scout never messages anyone for you.
          </p>
        </section>
      </div>
    </main>
  );
}
