import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { TopicForm } from "@/components/discovery/TopicForm";
import { TopicList } from "@/components/discovery/TopicList";
import { EmptyState } from "@/components/EmptyState";
import { OpportunityCard } from "@/components/opportunities/OpportunityCard";
import { toDrafts } from "@/components/opportunities/toDrafts";
import { RunScoutButton } from "@/components/watchlist/RunScoutButton";
import { getDiscoveryFeed, getDiscoveryTopics } from "@/db/queries/discovery";
import { getCurrentReplies, getLastReplyStyles } from "@/db/queries/replies";
import { countActiveWatchlist } from "@/db/queries/watchlist";
import { requireProfile } from "@/lib/auth/session";
import { effectiveLimits } from "@/lib/billing/plans";
import { formatRelative } from "@/lib/format";
import { BUDGET_MESSAGES, getUsageBudget, scanBlockedBy } from "@/services/billing/budget";

export const metadata: Metadata = { title: "Smart Discovery" };

const SCORE_FILTERS = [
  { value: "", label: "Any score" },
  { value: "60", label: "60+" },
  { value: "75", label: "75+" },
];
const RECENT_FILTERS = [
  { value: "", label: "Any time" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
];

export default function DiscoveryPage({ searchParams }: PageProps<"/discovery">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Discovery searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Discovery({ searchParams }: { searchParams: PageProps<"/discovery">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

  const topics = await getDiscoveryTopics(profile.id);
  // Filters: only the user's own topics and known values are accepted
  const topicId = topics.some((topic) => topic.id === one(params.topic)) ? one(params.topic) : "";
  const minScore = SCORE_FILTERS.some((f) => f.value === one(params.score)) ? one(params.score) : "";
  const days = RECENT_FILTERS.some((f) => f.value === one(params.days)) ? one(params.days) : "";

  const [feed, activeAccounts, budget] = await Promise.all([
    getDiscoveryFeed(profile.id, {
      topicId: topicId || undefined,
      minScore: minScore ? Number(minScore) : undefined,
      sinceDays: days ? Number(days) : undefined,
    }),
    countActiveWatchlist(profile.id),
    getUsageBudget(profile),
  ]);
  const [replies, lastStyles] = await Promise.all([
    getCurrentReplies(profile.id, feed.map((item) => item.id)),
    getLastReplyStyles(profile.id),
  ]);

  const maxTopics = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxDiscoveryTopics;
  const activeTopics = topics.filter((topic) => topic.isActive).length;
  const topicNames = new Map(topics.map((topic) => [topic.id, topic.name]));
  const blocked = scanBlockedBy(budget);
  const filtered = Boolean(topicId || minScore || days);

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Smart Discovery</p>
          <h1>Find conversations beyond your watchlist.</h1>
          <p className="lede">
            Describe what you want to find. Scout searches recent posts on X during your scans, scores them against
            your Scout Brain and shows the ones worth a reply.
          </p>
        </div>
      </section>

      <div className="discovery-layout">
        <section aria-labelledby="topics-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {activeTopics} / {maxTopics} active on your plan
              </p>
              <h2 id="topics-title">Topics</h2>
            </div>
          </div>
          <TopicList
            topics={topics.map((topic) => ({
              id: topic.id,
              name: topic.name,
              description: topic.description ?? "",
              keywords: topic.keywords,
              excludedKeywords: topic.excludedKeywords,
              isActive: topic.isActive,
              lastSearchedLabel: topic.lastSearchedAt ? formatRelative(topic.lastSearchedAt) : null,
            }))}
          />
          <h3 className="eyebrow" style={{ marginTop: 28, marginBottom: 10 }}>
            New topic
          </h3>
          <TopicForm />
        </section>

        <section aria-labelledby="discovery-feed-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Best first</p>
              <h2 id="discovery-feed-title">Discovered conversations</h2>
            </div>
          </div>
          <p className="memory-note">
            Searches run with every scan (manual or automatic) and share your plan&apos;s X and AI budget with your
            watchlist. A post already found through your watchlist isn&apos;t scored twice.
          </p>
          <RunScoutButton disabled={(activeAccounts === 0 && activeTopics === 0) || blocked !== null} />
          {blocked && <p className="memory-note">{BUDGET_MESSAGES[blocked]}</p>}

          <form className="discovery-filters" method="get">
            <label>
              Topic
              <select name="topic" defaultValue={topicId}>
                <option value="">All topics</option>
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Relevance
              <select name="score" defaultValue={minScore}>
                {SCORE_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Found
              <select name="days" defaultValue={days}>
                {RECENT_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="secondary-button">
              Filter
            </button>
            {filtered && (
              <Link href="/discovery" className="text-link">
                Clear
              </Link>
            )}
          </form>

          {feed.length ? (
            <div className="opportunity-feed">
              {feed.map((opportunity) => (
                <OpportunityCard
                  key={opportunity.id}
                  opportunity={opportunity}
                  sourceLabel={opportunity.discoveryTopicId ? topicNames.get(opportunity.discoveryTopicId) : undefined}
                  replies={toDrafts(replies.get(opportunity.id))}
                  defaultStyles={lastStyles ?? undefined}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title={filtered ? "Nothing matches these filters." : "No discovered conversations yet."}
              description={
                filtered
                  ? "Try another topic, a lower score or a longer time range."
                  : topics.length === 0
                    ? "Create a topic first. Scout searches it in your next scan and shows the posts worth a reply here."
                    : "Run Scout to search your active topics. Only posts that fit your Scout Brain appear here, so some scans find nothing."
              }
              action={{ href: "/dashboard", label: "Back to dashboard" }}
            />
          )}
        </section>
      </div>
    </main>
  );
}
