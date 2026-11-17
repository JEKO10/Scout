import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { PlanForm } from "@/components/content/PlanForm";
import { TimeZoneHint } from "@/components/content/TimeZoneHint";
import { getPlannedDrafts, getProfileTimeZone, getSavedTrendsWithoutContent, getUnplannedDrafts } from "@/db/queries/content";
import type { ContentDraft } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";
import {
  calendarDays,
  isValidTimeZone,
  lifecycle,
  LIFECYCLE_LABEL,
  planningAdvice,
  shiftAnchor,
  weekSummary,
  zonedParts,
  zonedTimeToUtc,
} from "@/lib/content/calendar";
import { CONTENT_GOALS, GOAL_LABEL } from "@/lib/content/types";
import { noteMissedPlans } from "@/services/content/calendar";

export const metadata: Metadata = { title: "Content Calendar" };

const VIEWS = ["month", "week", "list"] as const;
type View = (typeof VIEWS)[number];

export default function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Calendar searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Calendar({ searchParams }: { searchParams: PageProps<"/calendar">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

  // Dates are stored in UTC and shown in one time zone: the chosen one, the
  // one from your settings, or UTC
  const savedTz = await getProfileTimeZone(profile.id);
  const tz = isValidTimeZone(one(params.tz)) ? one(params.tz) : savedTz && isValidTimeZone(savedTz) ? savedTz : "UTC";
  const view: View = (VIEWS as readonly string[]).includes(one(params.view)) ? (one(params.view) as View) : "month";
  const now = new Date();
  const today = zonedParts(now, tz).date;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(one(params.date)) ? one(params.date) : today;

  await noteMissedPlans(profile.id, now);

  const days = view === "list" ? [] : calendarDays(anchor, view === "week" ? "week" : "month");
  const rangeStart = view === "list" ? new Date(now.getTime() - 14 * 86_400_000) : zonedTimeToUtc(days[0], "00:00", tz)!;
  const rangeEnd =
    view === "list" ? new Date(now.getTime() + 60 * 86_400_000) : new Date(zonedTimeToUtc(days.at(-1)!, "00:00", tz)!.getTime() + 86_400_000);

  const weekDays = calendarDays(today, "week");
  const weekStart = zonedTimeToUtc(weekDays[0], "00:00", tz)!;
  const weekEnd = new Date(zonedTimeToUtc(weekDays[6], "00:00", tz)!.getTime() + 86_400_000);

  const [planned, unplanned, weekPlanned, trendsWithoutContent] = await Promise.all([
    getPlannedDrafts(profile.id, rangeStart, rangeEnd),
    getUnplannedDrafts(profile.id),
    getPlannedDrafts(profile.id, weekStart, weekEnd),
    getSavedTrendsWithoutContent(profile.id),
  ]);

  const byDay = new Map<string, ContentDraft[]>();
  for (const draft of planned) {
    const day = zonedParts(draft.plannedAt!, tz).date;
    byDay.set(day, [...(byDay.get(day) ?? []), draft]);
  }
  const item = (draft: ContentDraft) => ({ goal: draft.goal, lifecycle: lifecycle(draft, now), sourceTrendId: draft.sourceTrendId });
  const summary = weekSummary(weekPlanned.map(item), unplanned.map(item));
  const readyUnplanned = unplanned.filter((draft) => draft.status === "ready").length;
  const advice = planningAdvice(summary, readyUnplanned, trendsWithoutContent);

  const base = (overrides: Record<string, string>) => {
    const search = new URLSearchParams({ view, date: anchor, tz, ...overrides });
    return `/calendar?${search.toString()}`;
  };
  const baseQuery = new URLSearchParams({ view, date: anchor }).toString();
  const monthLabel = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${anchor}T12:00:00Z`));
  const dayLabel = (day: string, style: "short" | "long" = "short") =>
    new Intl.DateTimeFormat("en", { weekday: style, month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
  const time = (draft: ContentDraft) => zonedParts(draft.plannedAt!, tz).time;

  const Card = ({ draft }: { draft: ContentDraft }) => {
    const state = lifecycle(draft, now);
    return (
      <Link href={`/studio/${draft.id}?from=calendar`} className="cal-item" data-state={state}>
        <span className="cal-item-time">
          {time(draft)} · {LIFECYCLE_LABEL[state]}
        </span>
        <span className="cal-item-text">{draft.posts[0]?.slice(0, 80)}</span>
        <span className="cal-item-meta">
          {draft.format === "thread" ? `Thread · ${draft.posts.length}` : "Post"} · {GOAL_LABEL[draft.goal]}
        </span>
      </Link>
    );
  };

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Content Calendar</p>
          <h1>Plan what you&apos;ll post.</h1>
          <p className="lede">
            A plan, not a scheduler: Scout never posts for you. When a post&apos;s time comes, open it, post it on X, and mark it
            posted.
          </p>
        </div>
      </section>

      <section className="metrics-strip crm-metrics" aria-label="This week">
        <div className="metric">
          <strong>{summary.planned}</strong>
          <span>Planned this week</span>
        </div>
        <div className="metric">
          <strong>{summary.published}</strong>
          <span>Posted (you confirmed)</span>
        </div>
        <div className="metric">
          <strong>{summary.missed}</strong>
          <span>Missed</span>
        </div>
        <div className="metric">
          <strong>{summary.awaitingReview}</strong>
          <span>Drafts awaiting review</span>
        </div>
        <div className="metric">
          <strong>{readyUnplanned}</strong>
          <span>Ready, no date</span>
        </div>
        <div className="metric">
          <strong>{Object.keys(summary.goals).length}</strong>
          <span>Goals covered this week</span>
        </div>
      </section>
      {Object.keys(summary.goals).length > 0 && (
        <p className="memory-note">
          This week&apos;s mix:{" "}
          {CONTENT_GOALS.filter((goal) => summary.goals[goal])
            .map((goal) => `${GOAL_LABEL[goal]} ${summary.goals[goal]}`)
            .join(" · ")}
        </p>
      )}
      {advice.length > 0 && (
        <section className="crm-panel" aria-labelledby="advice-title">
          <h2 id="advice-title">Planning suggestions</h2>
          <ul className="memory-list">
            {advice.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="memory-note">From your plan and saved trends. Scout doesn&apos;t suggest posting times until it has your results.</p>
        </section>
      )}

      <div className="discovery-filters cal-toolbar">
        <span className="crm-view-toggle" role="group" aria-label="View">
          {VIEWS.map((option) => (
            <Link key={option} href={base({ view: option })} aria-current={view === option ? "page" : undefined}>
              {option === "month" ? "Month" : option === "week" ? "Week" : "List"}
            </Link>
          ))}
        </span>
        {view !== "list" && (
          <>
            <Link href={base({ date: shiftAnchor(anchor, view, -1) })} className="secondary-button" aria-label="Previous">
              ←
            </Link>
            <strong>{view === "month" ? monthLabel : `${dayLabel(days[0])} – ${dayLabel(days[6])}`}</strong>
            <Link href={base({ date: shiftAnchor(anchor, view, 1) })} className="secondary-button" aria-label="Next">
              →
            </Link>
            <Link href={base({ date: today })} className="text-link">
              Today
            </Link>
          </>
        )}
        <span className="memory-note">Times in {tz}</span>
        <TimeZoneHint current={tz} baseQuery={baseQuery} />
      </div>

      <div className="discovery-layout cal-layout">
        <section aria-label="Calendar">
          {view === "list" ? (
            planned.length === 0 ? (
              <p className="memory-note">Nothing planned in the last 2 weeks or the next 2 months.</p>
            ) : (
              <ol className="cal-list">
                {planned.map((draft) => (
                  <li key={draft.id}>
                    <span className="cal-list-day">{dayLabel(zonedParts(draft.plannedAt!, tz).date, "long")}</span>
                    <Card draft={draft} />
                  </li>
                ))}
              </ol>
            )
          ) : (
            <div className="cal-grid" data-view={view}>
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => (
                <span key={name} className="cal-head">
                  {name}
                </span>
              ))}
              {days.map((day) => {
                const items = byDay.get(day) ?? [];
                const outside = view === "month" && day.slice(0, 7) !== anchor.slice(0, 7);
                return (
                  <div key={day} className="cal-day" data-today={day === today || undefined} data-outside={outside || undefined}>
                    <div className="cal-day-head">
                      <span>{Number(day.slice(8))}</span>
                      <Link href={`/studio?plan=${day}&tz=${encodeURIComponent(tz)}`} className="cal-add" aria-label={`New draft for ${dayLabel(day, "long")}`}>
                        +
                      </Link>
                    </div>
                    {items.map((draft) => (
                      <Card key={draft.id} draft={draft} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <aside aria-labelledby="unplanned-title">
          <h2 id="unplanned-title" className="eyebrow">
            Drafts without a date
          </h2>
          {unplanned.length === 0 ? (
            <p className="memory-note">
              Every draft has a date. <Link href="/studio">Write a new one</Link>.
            </p>
          ) : (
            <ul className="crm-notes">
              {unplanned.map((draft) => (
                <li key={draft.id}>
                  <Link href={`/studio/${draft.id}?from=calendar`}>{draft.title}</Link>
                  <small>
                    {draft.status === "ready" ? "Ready" : "Draft"} · {draft.format === "thread" ? "Thread" : "Post"} · {GOAL_LABEL[draft.goal]}
                  </small>
                  <details>
                    <summary className="text-link">Plan it</summary>
                    <PlanForm
                      draftId={draft.id}
                      compact
                      initial={{ date: today, time: "09:00", timeZone: tz, goal: draft.goal, note: "", planned: false }}
                    />
                  </details>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </main>
  );
}
