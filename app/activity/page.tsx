import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ActivityItemActions } from "@/components/activity/ActivityItemActions";
import { AppHeader } from "@/components/AppHeader";
import { EmptyState } from "@/components/EmptyState";
import { getReplyActivity, getReplyIntentStats } from "@/db/queries/replyIntents";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { truncateAtWord } from "@/lib/notifications/slackMessage";

// Day 21: replies the user opened on X from Scout. Scout can't see X, so an
// opened composer is shown as exactly that, never as a published reply.

export default function ActivityPage() {
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
        <Activity />
      </Suspense>
    </div>
  );
}

async function Activity() {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const [items, stats] = await Promise.all([getReplyActivity(profile.id), getReplyIntentStats(profile.id)]);

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Activity</p>
          <h1>Your replies.</h1>
          <p className="lede">
            Replies you opened on X from Scout. Scout can&apos;t see what you post on X, so they stay
            unconfirmed unless you mark them posted.
          </p>
        </div>
        <Link href="/opportunities" className="secondary-button">
          Opportunities
        </Link>
      </section>

      <section className="metrics-strip" aria-label="Reply activity">
        <div className="metric">
          <strong>{stats.opened}</strong>
          <span>Opened on X (measured)</span>
        </div>
        <div className="metric">
          <strong>{stats.confirmed}</strong>
          <span>Marked posted (your word)</span>
        </div>
        <div className="metric">
          <strong>{stats.edited}</strong>
          <span>Edited before sending</span>
        </div>
        <div className="metric">
          <strong>–</strong>
          <span>Verified on X (not available)</span>
        </div>
      </section>

      {items.length === 0 ? (
        <EmptyState
          title="No replies yet"
          description="Open an opportunity, pick or edit a reply and click Reply on X. It shows up here."
          action={{ href: "/opportunities", label: "Find a conversation" }}
        />
      ) : (
        <ul className="activity-list">
          {items.map(({ intent, opportunity }) => (
            <li key={intent.id} className="activity-item">
              <header>
                <span className="activity-status" data-confirmed={intent.status === "confirmed" || undefined}>
                  {intent.status === "confirmed" ? "Marked posted by you" : "Opened on X · unconfirmed"}
                </span>
                <span className="activity-meta">
                  {Math.round(opportunity.score ?? 0)}/100 ·{" "}
                  <time dateTime={intent.openedAt.toISOString()}>{formatRelative(intent.openedAt)}</time>
                </span>
              </header>
              <p className="activity-post">
                <strong>@{opportunity.authorHandle}</strong> {truncateAtWord(opportunity.content.replace(/\s+/g, " "), 200)}
              </p>
              <blockquote className="activity-reply">{intent.text}</blockquote>
              <ActivityItemActions
                opportunityId={opportunity.id}
                confirmed={intent.status === "confirmed"}
                postUrl={opportunity.postUrl}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
