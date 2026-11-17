import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { AppHeader } from "@/components/AppHeader";
import { InfoHint } from "@/components/InfoHint";
import { OpenConversationLink } from "@/components/trends/OpenConversationLink";
import { TrendActions } from "@/components/trends/TrendActions";
import { TrendBars } from "@/components/trends/TrendBars";
import { getTrend, getTrendPosts } from "@/db/queries/trends";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { OBSERVATION_DAYS } from "@/lib/trends/detect";
import {
  CONFIDENCE_LABEL,
  momentumText,
  opportunityExplanation,
  STATUS_LABEL,
  TIMING_LABEL,
  TIMING_TEXT,
} from "@/lib/trends/labels";
import { track } from "@/services/analytics/track";
import { insightIsStale } from "@/services/trends/insight";

export const metadata: Metadata = { title: "Trend" };

const number = new Intl.NumberFormat("en");
const FORMAT_LABEL = { short_post: "Short X post", thread: "Thread", reply: "Reply to an existing conversation", question: "Question to your audience" } as const;
const SENTIMENT_LABEL = { positive: "Mostly positive", negative: "Mostly negative", mixed: "Mixed", neutral: "Neutral" } as const;

export default function TrendPage(props: PageProps<"/trends/[id]">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <TrendDetail {...props} />
      </Suspense>
    </div>
  );
}

async function TrendDetail({ params }: PageProps<"/trends/[id]">) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const trend = await getTrend(profile.id, id);
  if (!trend) notFound();
  await track("trend_viewed", { profileId: profile.id });

  const posts = await getTrendPosts(profile.id, trend.representativeCandidateIds);
  // Conversations you can act on first: the ones that are opportunities
  const conversations = [...posts].sort((a, b) => Number(Boolean(b.opportunityId)) - Number(Boolean(a.opportunityId)));
  const authors = [...new Set(posts.map((post) => post.candidate.authorHandle))];
  const b = trend.scoreBreakdown;
  const insight = trend.insight;
  const stale = insightIsStale(trend);
  const supporting = insight ? posts.filter(({ candidate }) => insight.supportingCandidateIds.includes(candidate.id)) : [];

  return (
    <main className="workspace shell enter-content">
      <p className="eyebrow">
        <Link href="/trends">← Trends</Link>
      </p>
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">
            <span className="trend-status" data-status={trend.status}>
              {STATUS_LABEL[trend.status]}
            </span>{" "}
            · {CONFIDENCE_LABEL[trend.confidence]}
          </p>
          <h1>{trend.label}</h1>
          <p className="lede">{trend.summary}</p>
          <TrendActions trendId={trend.id} saved={trend.saved} hasInsight={Boolean(insight)} stale={Boolean(insight) && stale} />
          <Link href={`/studio?trend=${trend.id}`} className="text-link">
            Create content from this trend →
          </Link>
        </div>
      </section>

      {trend.timing && (
        <p className="crm-next-banner" data-tone={trend.timing === "act_now" ? "urgent" : "info"} role="status">
          <strong>{TIMING_LABEL[trend.timing]}:</strong> {TIMING_TEXT[trend.timing]} Scout can&apos;t predict when a trend
          peaks.
        </p>
      )}

      <section className="metrics-strip trend-scores" aria-label="Scores">
        <div className="metric">
          <strong>{trend.opportunityScore}</strong>
          <span>Opportunity: how worthwhile it is for you to take part</span>
        </div>
        <div className="metric">
          <strong>{trend.relevance}</strong>
          <span>Relevance: how closely its posts match your Scout Brain</span>
        </div>
        <div className="metric">
          <strong>{b.momentum}/35</strong>
          <span>Momentum: {STATUS_LABEL[trend.status].toLowerCase()} in the posts Scout saw</span>
        </div>
      </section>
      {trend.opportunityBreakdown && (
        <InfoHint text="About the opportunity score">Opportunity score: {opportunityExplanation(trend.opportunityBreakdown)}. Not a prediction of reach or followers.</InfoHint>
      )}

      <div className="discovery-layout">
        <section aria-labelledby="evidence-title">
          <h2 id="evidence-title" className="eyebrow">
            Observed evidence
          </h2>
          <p className="memory-note">{momentumText(trend.momentum)}</p>
          <TrendBars counts={trend.dailyCounts} />
          <ul className="memory-list">
            <li>
              {trend.postCount} posts from {trend.authorCount} accounts in your scans, last {OBSERVATION_DAYS} days
            </li>
            <li>Engagement X reported on them: {number.format(trend.engagement)} likes, replies and reposts</li>
            <li>
              First post {formatRelative(trend.firstPostAt)} · latest {formatRelative(trend.lastPostAt)} · updated{" "}
              {formatRelative(trend.updatedAt)}
            </li>
            {trend.terms.length > 0 && <li>Often mentioned: {trend.terms.join(", ")}</li>}
          </ul>
          <InfoHint text="Score breakdown">
            Trend score {trend.score}: momentum {b.momentum}/35 · relevance {b.relevance}/35 · engagement {b.engagement}/10 ·
            sources {b.sources}/10 · freshness {b.freshness}/10. A sample Scout collected for you, not all of X.
          </InfoHint>

          {insight ? (
            <section className="ai-insight" aria-labelledby="insight-title">
              <h2 id="insight-title">
                <span className="ai-tag">AI</span> Interpretation of these posts
              </h2>
              <p className="memory-note">
                Written {trend.insightGeneratedAt ? formatRelative(trend.insightGeneratedAt) : ""} from {posts.length} representative posts.
                {stale && " New posts arrived since; you can refresh it."}
              </p>
              <h3>What people are discussing</h3>
              <p>{insight.discussion}</p>
              <h3>What seems to drive it</h3>
              <p>{insight.drivers}</p>
              {insight.recurringQuestions.length > 0 && (
                <>
                  <h3>Recurring questions</h3>
                  <ul className="memory-list">
                    {insight.recurringQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </>
              )}
              <p>
                <strong>Tone:</strong> {SENTIMENT_LABEL[insight.sentiment]}
              </p>
              <h3>Why it matters to you</h3>
              <p>{insight.whyItMatters}</p>
              <h3>Recommended action</h3>
              <p>{insight.recommendedAction}</p>
              {supporting.length > 0 && (
                <p className="memory-note">
                  Based on:{" "}
                  {supporting.map(({ candidate }, i) => (
                    <span key={candidate.id}>
                      {i > 0 && ", "}
                      <a href={candidate.url} target="_blank" rel="noreferrer">
                        @{candidate.authorHandle}
                      </a>
                    </span>
                  ))}
                </p>
              )}

              <h2 className="ai-insight-ideas">
                <span className="ai-tag">AI</span> Content ideas
              </h2>
              <ul className="memory-list">
                <li>
                  <strong>Educational:</strong> {insight.angles.educational}
                </li>
                <li>
                  <strong>From your experience:</strong> {insight.angles.personal}
                </li>
                <li>
                  <strong>Practical advice:</strong> {insight.angles.practical}
                </li>
                {insight.angles.contrarian && (
                  <li>
                    <strong>Contrarian:</strong> {insight.angles.contrarian}
                  </li>
                )}
              </ul>
              <h3>Hooks</h3>
              <ul className="memory-list">
                {insight.hooks.map((hook) => (
                  <li key={hook}>&ldquo;{hook}&rdquo;</li>
                ))}
              </ul>
              <p>
                <strong>Format:</strong> {FORMAT_LABEL[insight.format.type]}. {insight.format.why}
              </p>
              <p className="memory-note">Ideas only: nothing is posted. Edit them into your own words.</p>
            </section>
          ) : (
            trend.why && (
              <section className="opportunity-section">
                <h3>Why it matters to you</h3>
                <p>{trend.why}</p>
                <InfoHint text="Where this comes from">
                  From the scoring of its best post. &ldquo;Explain this trend&rdquo; writes a fuller AI interpretation and content ideas.
                </InfoHint>
              </section>
            )
          )}

          {authors.length > 0 && (
            <p className="memory-note">
              Accounts in this sample:{" "}
              {authors.map((handle, i) => (
                <span key={handle}>
                  {i > 0 && ", "}
                  <a href={`https://x.com/${encodeURIComponent(handle)}`} target="_blank" rel="noreferrer">
                    @{handle}
                  </a>
                </span>
              ))}
            </p>
          )}
        </section>

        <section aria-labelledby="posts-title">
          <h2 id="posts-title" className="eyebrow">
            Recommended conversations
          </h2>
          {conversations.length === 0 ? (
            <p className="memory-note">These posts are no longer stored. They return with your next scans if the trend continues.</p>
          ) : (
            <div className="opportunity-feed">
              {conversations.map(({ candidate, opportunityId }) => (
                <article key={candidate.id} className="opportunity-card">
                  <header>
                    <p className="opportunity-score">
                      <strong>{candidate.score ?? "–"}</strong> · relevance to you
                    </p>
                    {opportunityId && <span className="opportunity-saved">Opportunity</span>}
                  </header>
                  <p className="opportunity-author">
                    <span>@{candidate.authorHandle}</span> · {formatRelative(candidate.postedAt)}
                  </p>
                  <blockquote className="opportunity-post">{candidate.content}</blockquote>
                  {candidate.reason && <p className="memory-note">{candidate.reason}</p>}
                  <div className="topic-actions">
                    {opportunityId ? (
                      <OpenConversationLink trendId={trend.id} href={`/opportunities/${opportunityId}`}>
                        Open opportunity and draft a reply →
                      </OpenConversationLink>
                    ) : (
                      <span className="memory-note">Below your opportunity threshold</span>
                    )}
                    <OpenConversationLink trendId={trend.id} href={candidate.url} external>
                      Open on X ↗
                    </OpenConversationLink>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
