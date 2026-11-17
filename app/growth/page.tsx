import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { EmptyState } from "@/components/EmptyState";
import { GrowthBars } from "@/components/growth/GrowthBars";
import { RefreshGrowthButton } from "@/components/growth/RefreshGrowthButton";
import { InfoHint, TitleWithHint } from "@/components/InfoHint";
import { getProfileTimeZone } from "@/db/queries/content";
import { requireProfile } from "@/lib/auth/session";
import { isValidTimeZone, zonedParts } from "@/lib/content/calendar";
import { GOAL_LABEL } from "@/lib/content/types";
import { formatRelative } from "@/lib/format";
import {
  CONFIDENCE_LABEL,
  engagement,
  engagementRate,
  type Finding,
  type GrowthPost,
  NOT_ENOUGH_FOR_TIMES,
  POST_SORTS,
  type PostSort,
  sortPosts,
  type Stat,
} from "@/lib/growth/analyze";
import {
  GROWTH_RANGES,
  type GrowthRange,
  X_ENGAGEMENT_DEFINITION,
  X_ENGAGEMENT_RATE_DEFINITION,
  xCapabilities,
} from "@/lib/growth/metrics";
import { track } from "@/services/analytics/track";
import { getUsageBudget } from "@/services/billing/budget";
import { GROWTH_REFRESH_MIN_HOURS, GROWTH_REFRESH_POSTS, PRIVATE_METRICS_WINDOW_DAYS } from "@/services/growth/collect";
import { buildGrowthReport, growthRecommendations } from "@/services/growth/report";

export const metadata: Metadata = { title: "Growth Intelligence" };

const SORT_LABEL: Record<PostSort, string> = {
  impressions: "Most impressions",
  rate: "Highest engagement rate",
  replies: "Most replies",
  recent: "Most recent",
};

const num = (value: number | null) => (value === null ? "—" : Math.round(value).toLocaleString("en-US"));
const pct = (value: number | null, digits = 1) => (value === null ? "—" : `${(value * 100).toFixed(digits)}%`);

export default function GrowthPage({ searchParams }: PageProps<"/growth">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Growth searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function Change({ stat, unavailable }: { stat: Stat; unavailable: string }) {
  if (stat.value === null) return <small className="growth-na">{unavailable}</small>;
  if (stat.change === null) return <small>No comparable previous period</small>;
  const up = stat.change >= 0;
  return (
    <small data-trend={up ? "up" : "down"}>
      {up ? "▲" : "▼"} {pct(Math.abs(stat.change), 0)} vs previous period
    </small>
  );
}

function PostLine({ post }: { post: GrowthPost }) {
  return (
    <li>
      {post.url ? (
        <a href={post.url} target="_blank" rel="noreferrer">
          {post.text.slice(0, 110)}
        </a>
      ) : (
        post.text.slice(0, 110)
      )}
      <small>
        {num(post.impressions)} impressions · {num(post.likes)} likes · {num(post.replies)} replies · ER {pct(engagementRate(post))}
      </small>
    </li>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <article className="growth-finding" data-kind={finding.kind}>
      <p>
        <strong>{finding.text}</strong>
      </p>
      <p className="memory-note">{finding.evidence}</p>
      <p className="memory-note">
        Confidence: {CONFIDENCE_LABEL[finding.confidence]} ({finding.totalN} posts analyzed, {finding.groupN} in this group)
      </p>
      <ul className="crm-notes">
        {finding.examples.map((post) => (
          <PostLine key={post.id} post={post} />
        ))}
      </ul>
    </article>
  );
}

async function Growth({ searchParams }: { searchParams: PageProps<"/growth">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");
  const range = (GROWTH_RANGES.find((r) => String(r) === one(params.range)) ?? 30) as GrowthRange;
  const sort = (POST_SORTS as readonly string[]).includes(one(params.sort)) ? (one(params.sort) as PostSort) : "impressions";
  const savedTz = await getProfileTimeZone(profile.id);
  const tz = savedTz && isValidTimeZone(savedTz) ? savedTz : "UTC";

  const [report, budget] = await Promise.all([buildGrowthReport(profile, { range, tz }), getUsageBudget(profile)]);
  await track("growth_viewed", { profileId: profile.id });
  const link = (overrides: Record<string, string>) => `/growth?${new URLSearchParams({ range: String(range), sort, ...overrides })}`;

  const refreshBlocked =
    !profile.xHandle
      ? "Add your X handle in Settings first."
      : report.lastRefresh && report.now.getTime() - report.lastRefresh.getTime() < GROWTH_REFRESH_MIN_HOURS * 3_600_000
        ? `Refreshed ${formatRelative(report.lastRefresh)}. Available again once a day.`
        : budget.remaining.xPostReads < GROWTH_REFRESH_POSTS
          ? `Not enough X reads left on your plan right now (${budget.remaining.xPostReads} of ${GROWTH_REFRESH_POSTS} needed).`
          : null;

  const heading = (
    <section className="workspace-heading">
      <div>
        <TitleWithHint
          title="Growth Intelligence"
          hint={
            <>
              From your real posts and their public X numbers. Missing numbers stay missing; patterns are shown only with enough posts, and they show what goes together, not what caused it.
            </>
          }
        />
        <p className="lede">What&apos;s working on X.</p>
      </div>
      <RefreshGrowthButton
        posts={GROWTH_REFRESH_POSTS}
        disabledReason={refreshBlocked}
        description={
          report.xConnection?.status === "active"
            ? `Reads up to ${GROWTH_REFRESH_POSTS} of your posts from the last ${PRIVATE_METRICS_WINDOW_DAYS} days with private metrics, and your follower count. Uses your plan's X reads; once a day.`
            : undefined
        }
      />
    </section>
  );

  if (!("posts" in report) || !report.account) {
    return (
      <main className="workspace shell enter-content">
        {heading}
        <EmptyState
          title="No X account connected yet."
          description="Add your X handle and sync your posts (or import an X export) in Settings. Growth Intelligence then works from those posts."
          action={{ href: "/account/settings", label: "Open Settings" }}
        />
      </main>
    );
  }

  const o = report.overview;
  const recs = growthRecommendations(report);
  const works = report.findings.filter((finding) => finding.kind === "works").slice(0, 4);
  const weak = report.findings.filter((finding) => finding.kind !== "works").slice(0, 4);
  const sorted = sortPosts(report.posts, sort);
  const r = report.replies;
  const ra = report.replyActivity;
  const connected = report.xConnection?.status === "active";
  const caps = xCapabilities(connected);
  const pm = report.privateMetrics;
  const privateNote = !report.xConnection && pm.covered > 0
    ? `From ${pm.covered} of ${pm.total} posts, read while X was connected`
    : !report.xConnection
    ? "Connect X in Settings to see this"
    : report.xConnection.status !== "active" && pm.covered === 0
      ? "Reconnect X in Settings"
      : pm.covered === 0
        ? `No post of this period has private metrics yet (X keeps them ${PRIVATE_METRICS_WINDOW_DAYS + 1} days)`
        : `From ${pm.covered} of ${pm.total} posts (X keeps them ${PRIVATE_METRICS_WINDOW_DAYS + 1} days)`;
  const sourceLabel = (post: GrowthPost) =>
    post.source === "x_api" ? "Metrics from X" : post.source === "csv_import" ? "From your X export" : "Synced earlier";

  return (
    <main className="workspace shell enter-content">
      {heading}

      <div className="growth-source">
        @{report.account.handle} · {connected ? "X connected: public and private metrics" : "public X metrics"} ·{" "}
        {report.account.lastSyncedAt ? `last read ${formatRelative(report.account.lastSyncedAt)}` : "never synced"}
        {report.oldest && ` · posts since ${report.oldest.toISOString().slice(0, 10)}`}
        <InfoHint label="About this data">
          {connected ? (
            <p>
              Your X account is connected (read-only). Profile clicks and link clicks come from X&apos;s private metrics, which X
              only has for posts from the last 30 days; older posts keep the last reading Scout took.
            </p>
          ) : (
            <p>Scout reads public data; it isn&apos;t signed in to your X account.</p>
          )}
          {!caps.profileVisits.available && <p>Not available: profile visits and link clicks. {caps.profileVisits.reason}</p>}
          <p>
            Engagement = {X_ENGAGEMENT_DEFINITION}. Engagement rate = {X_ENGAGEMENT_RATE_DEFINITION}. Numbers are lifetime
            totals at the time Scout read them, so the newest posts are still collecting views.
          </p>
        </InfoHint>
      </div>

      <div className="discovery-filters cal-toolbar">
        <span className="crm-view-toggle" role="group" aria-label="Period">
          {GROWTH_RANGES.map((option) => (
            <Link key={option} href={link({ range: String(option) })} aria-current={range === option ? "page" : undefined}>
              {option} days
            </Link>
          ))}
        </span>
        {!o.complete && (
          <span className="memory-note">Scout only holds your posts since {report.oldest?.toISOString().slice(0, 10)}: this period is partial.</span>
        )}
      </div>

      <section className="metrics-strip crm-metrics" aria-label="Growth overview">
        <div className="metric">
          <strong>{num(o.impressions.value)}</strong>
          <span>Impressions</span>
          <Change stat={o.impressions} unavailable="X reported no impressions for these posts" />
        </div>
        <div className="metric">
          <strong>{num(o.engagement.value)}</strong>
          <span>Engagement</span>
          <Change stat={o.engagement} unavailable="No engagement data" />
        </div>
        <div className="metric">
          <strong>{pct(o.engagementRate.value, 2)}</strong>
          <span>Engagement rate</span>
          <Change stat={o.engagementRate} unavailable="Needs impressions" />
        </div>
        <div className="metric">
          <strong>{o.followers.current === null ? "—" : num(o.followers.current)}</strong>
          <span>Followers</span>
          <small className={o.followers.net === null ? "growth-na" : undefined}>
            {o.followers.net === null
              ? "Needs two readings on different days (each sync or refresh takes one)"
              : `${o.followers.net >= 0 ? "+" : ""}${o.followers.net} since ${o.followers.since}${o.followers.growth !== null ? ` (${pct(o.followers.growth)})` : ""}${o.followers.previousNet !== null ? ` · previous period ${o.followers.previousNet >= 0 ? "+" : ""}${o.followers.previousNet}` : ""}`}
          </small>
        </div>
        <div className="metric">
          <strong>{o.posts.value === null ? `${report.posts.length}+` : num(o.posts.value)}</strong>
          <span>Posts published (incl. replies)</span>
          <Change stat={o.posts} unavailable="Scout may not hold every post of this period" />
        </div>
        <div className="metric">
          <strong>{num(pm.profileClicks)}</strong>
          <span>Profile clicks</span>
          <small className={pm.profileClicks === null ? "growth-na" : undefined}>{privateNote}</small>
        </div>
        <div className="metric">
          <strong>{num(pm.linkClicks)}</strong>
          <span>Link clicks</span>
          <small className={pm.linkClicks === null ? "growth-na" : undefined}>{privateNote}</small>
        </div>
        <div className="metric">
          <strong>{num(o.avgImpressions.value)}</strong>
          <span>Avg impressions per post</span>
          <small>
            {o.postsWithImpressions} posts with impressions{o.medianImpressions !== null && ` · median ${num(o.medianImpressions)}`}
          </small>
        </div>
      </section>

      <section className="crm-panel" aria-labelledby="trends-title">
        <h2 id="trends-title">Performance over time</h2>
        {report.daily ? (
          <div className="growth-charts">
            <GrowthBars points={report.daily.map((p) => ({ day: p.day, value: p.impressions }))} caption="Impressions of posts by publish day" unit="impressions" />
            <GrowthBars points={report.daily.map((p) => ({ day: p.day, value: p.engagement }))} caption="Engagement of posts by publish day" unit="engagements" />
          </div>
        ) : (
          <p className="memory-note">Not enough posts with impressions in this period to chart (needs 5 posts on 3 different days).</p>
        )}
        {report.followers ? (
          <GrowthBars points={report.followers.map((p) => ({ day: p.day, value: p.followers }))} caption="Followers, as read on each day" unit="followers" />
        ) : (
          <p className="memory-note">Follower history starts with your first sync or refresh; a chart needs readings on 3 different days.</p>
        )}
      </section>

      <section className="crm-panel" aria-labelledby="insights-title">
        <h2 id="insights-title">Growth insights</h2>
        {recs.length === 0 ? (
          <p className="memory-note">
            No reliable pattern yet. Scout needs at least 10 original posts with impressions in this period, and groups of 5 or more to
            compare. Try the 90-day view or refresh after posting more.
          </p>
        ) : (
          <ol className="growth-recs">
            {recs.map((rec) => (
              <li key={rec.finding}>
                <p>
                  <strong>Finding:</strong> {rec.finding}
                </p>
                <p>
                  <strong>Evidence:</strong> {rec.evidence}
                </p>
                <p>
                  <strong>Suggested action:</strong> {rec.action}
                </p>
                <p className="memory-note">
                  <strong>Confidence:</strong> {rec.confidence}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="discovery-layout growth-columns">
        <section aria-labelledby="works-title">
          <h2 id="works-title">What works</h2>
          {works.length === 0 ? <p className="memory-note">Nothing stands out above your usual results yet.</p> : works.map((f) => <FindingCard key={`${f.dimension}-${f.group}`} finding={f} />)}
        </section>
        <section aria-labelledby="weak-title">
          <h2 id="weak-title">What isn&apos;t working as well</h2>
          {weak.length === 0 ? (
            <p className="memory-note">No consistent weak spot. Scout needs at least 8 posts in a group before calling it weaker.</p>
          ) : (
            weak.map((f) => <FindingCard key={`${f.dimension}-${f.group}`} finding={f} />)
          )}
        </section>
      </div>

      <section className="crm-panel" aria-labelledby="topics-title">
        <h2 id="topics-title">Performance by topic</h2>
        {report.topics.length === 0 ? (
          <p className="memory-note">No topics matched yet. Topics come from Content Studio, your Scout Brain, and your Brain topics found in post text.</p>
        ) : (
          <div className="growth-table-wrap">
            <table className="growth-table">
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Posts</th>
                  <th>Median impressions</th>
                  <th>Engagement rate</th>
                  <th>Replies</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {report.topics.map((row) => (
                  <tr key={row.topic}>
                    <td>
                      {row.topic}
                      <small>{row.source === "studio" ? " · Studio" : row.source === "brain" ? " · Scout Brain" : " · keyword match"}</small>
                    </td>
                    <td>{row.posts}</td>
                    <td>{num(row.medianImpressions)}</td>
                    <td>{pct(row.engagementRate)}</td>
                    <td>{num(row.replies)}</td>
                    <td>{row.trend === null ? "Too few posts" : row.trend === "up" ? "Rising" : row.trend === "down" ? "Falling" : "Steady"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="discovery-layout growth-columns">
        <section className="crm-panel" aria-labelledby="times-title">
          <div className="title-with-hint">
            <h2 id="times-title">Posting times ({tz})</h2>
            <InfoHint label="About posting times">
              From your own posts only (needs 30 posts with impressions and 6 per time slot), not general advice.
            </InfoHint>
          </div>
          <p>{report.times.finding ?? NOT_ENOUGH_FOR_TIMES}</p>
          <ul className="memory-list">
            {report.times.buckets.map((bucket) => (
              <li key={bucket.bucket}>
                {bucket.label}: {bucket.posts} posts{bucket.posts > 0 && ` · median ${num(bucket.medianImpressions)} impressions`}
              </li>
            ))}
          </ul>
        </section>

        <section className="crm-panel" aria-labelledby="followers-title">
          <h2 id="followers-title">Followers and activity</h2>
          {report.followerWeeks.finding ? (
            <p>{report.followerWeeks.finding}</p>
          ) : (
            <p className="memory-note">
              Comparing follower changes with what you posted needs follower readings at both ends of at least 3 weeks. Scout takes a
              reading at each sync or refresh. It never says a post caused followers: X doesn&apos;t show that.
            </p>
          )}
        </section>
      </div>

      <section className="crm-panel" aria-labelledby="replies-title">
        <div className="title-with-hint">
          <h2 id="replies-title">Replies and conversations ({range} days)</h2>
          <InfoHint label="How replies are counted">
            A drafted reply isn&apos;t a posted one, opening X isn&apos;t posting, and your confirmation isn&apos;t
            verification. &ldquo;Found on X&rdquo; counts your replies that X returned in a sync or refresh and that answer a
            post you opened from Scout.
          </InfoHint>
        </div>
        <div className="metrics-strip crm-metrics">
          <div className="metric">
            <strong>{ra.opportunities}</strong>
            <span>Opportunities found</span>
          </div>
          <div className="metric">
            <strong>{ra.generated}</strong>
            <span>Replies Scout drafted</span>
          </div>
          <div className="metric">
            <strong>{ra.opened}</strong>
            <span>Opened on X</span>
          </div>
          <div className="metric">
            <strong>{ra.confirmed}</strong>
            <span>You said you posted</span>
          </div>
          <div className="metric">
            <strong>{r.viaScout.count}</strong>
            <span>Found on X (verified)</span>
          </div>
        </div>
        {r.all.count > 0 && (
          <p>
            Your replies this period: {r.all.count}, median {num(r.all.medianLikes)} likes
            {r.all.medianImpressions !== null && `, ${num(r.all.medianImpressions)} impressions`}.
            {r.comparable
              ? ` Replies to Scout opportunities: median ${num(r.viaScout.medianLikes)} likes vs ${num(r.others.medianLikes)} for your other replies.`
              : " Too few verified Scout replies to compare with your other replies."}
          </p>
        )}
      </section>

      <section aria-labelledby="posts-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{report.posts.length} posts in this period</p>
            <h2 id="posts-title">Post performance</h2>
          </div>
          <span className="crm-view-toggle" role="group" aria-label="Sort">
            {POST_SORTS.map((option) => (
              <Link key={option} href={link({ sort: option })} aria-current={sort === option ? "page" : undefined}>
                {SORT_LABEL[option]}
              </Link>
            ))}
          </span>
        </div>
        {sort === "rate" && <p className="memory-note">Posts without impressions have no engagement rate and are listed last.</p>}
        {report.confirmedWithoutMetrics > 0 && (
          <p className="memory-note">
            {report.confirmedWithoutMetrics} Studio {report.confirmedWithoutMetrics === 1 ? "draft" : "drafts"} you marked posted
            {" "}{report.confirmedWithoutMetrics === 1 ? "isn't" : "aren't"} matched to a post Scout read from X yet (confirmed by you, no
            verified metrics). Add the post link in Studio and refresh.
          </p>
        )}
        {sorted.length === 0 ? (
          <p className="memory-note">No posts from this period in Scout yet.</p>
        ) : (
          <div className="growth-table-wrap">
            <table className="growth-table">
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Published</th>
                  <th>Impressions</th>
                  <th>Likes</th>
                  <th>Replies</th>
                  <th>Reposts</th>
                  <th>Eng. rate</th>
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 50).map((post) => (
                  <tr key={post.id}>
                    <td>
                      {post.url ? (
                        <a href={post.url} target="_blank" rel="noreferrer">
                          {post.text.slice(0, 90)}
                        </a>
                      ) : (
                        post.text.slice(0, 90)
                      )}
                      <small>
                        {post.kind === "reply" ? "Reply" : post.kind === "quote" ? "Quote" : "Post"} · {sourceLabel(post)}
                        {post.topic && ` · ${post.topic}`}
                        {post.draft && ` · Studio: ${GOAL_LABEL[post.draft.goal]}, ${post.draft.format}`}
                      </small>
                    </td>
                    <td>
                      {zonedParts(post.publishedAt, tz).date} {zonedParts(post.publishedAt, tz).time}
                    </td>
                    <td>{num(post.impressions)}</td>
                    <td>{num(post.likes)}</td>
                    <td>{num(post.replies)}</td>
                    <td>{num(post.reposts)}</td>
                    <td>{engagement(post) === null ? "—" : pct(engagementRate(post))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
