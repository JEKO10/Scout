import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { AppHeader } from "@/components/AppHeader";
import { DraftEditor } from "@/components/content/DraftEditor";
import { PlanForm } from "@/components/content/PlanForm";
import { PublishedUrlForm } from "@/components/content/PublishedUrlForm";
import { ApproveForPublishing } from "@/components/inbox/ApproveForPublishing";
import { PublishCard } from "@/components/inbox/PublishCard";
import { InfoHint } from "@/components/InfoHint";
import { getDraft, getProfileTimeZone } from "@/db/queries/content";
import { latestPublicationsForDrafts } from "@/db/queries/publications";
import { getTrend } from "@/db/queries/trends";
import { isMissingSchemaError } from "@/db/schemaErrors";
import { requireProfile } from "@/lib/auth/session";
import { isValidTimeZone, lifecycle, LIFECYCLE_LABEL, zonedParts } from "@/lib/content/calendar";
import { GOAL_LABEL } from "@/lib/content/types";
import { PUBLICATION_LABEL } from "@/lib/x/publishing";
import { getPublishingState, toPublicationCard } from "@/services/x/publishing";

export const metadata: Metadata = { title: "Draft" };

export default function DraftPage(props: PageProps<"/studio/[id]">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Draft {...props} />
      </Suspense>
    </div>
  );
}

async function Draft({ params, searchParams }: PageProps<"/studio/[id]">) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const draft = await getDraft(profile.id, id);
  if (!draft) notFound();
  const [trend, savedTz, query] = await Promise.all([
    draft.sourceTrendId ? getTrend(profile.id, draft.sourceTrendId) : undefined,
    getProfileTimeZone(profile.id),
    searchParams,
  ]);
  const fromCalendar = query.from === "calendar";
  // Shown in the zone it was planned in, else the user's zone
  const tz = [draft.timeZone, savedTz].find((zone): zone is string => Boolean(zone && isValidTimeZone(zone))) ?? "UTC";
  const plannedParts = draft.plannedAt ? zonedParts(draft.plannedAt, tz) : null;
  const state = lifecycle(draft);
  // Day 40: publishing this draft on X (the same state Home and the Calendar show)
  const publishing = await getPublishingState(profile);
  const publication = publishing.available
    ? await latestPublicationsForDrafts(profile.id, [draft.id])
        .then((map) => map.get(draft.id))
        .catch((error: unknown) => {
          if (!isMissingSchemaError(error)) throw error;
          return undefined;
        })
    : undefined;
  const showPublication = publication && !publication.deletedAt;
  const canApprove = publishing.available && publishing.planAllows && draft.format === "post" && !draft.publishedConfirmedAt && !showPublication;

  return (
    <main className="workspace shell enter-content">
      <p className="eyebrow">
        {fromCalendar ? <Link href="/calendar">← Calendar</Link> : <Link href="/studio">← Content Studio</Link>}
      </p>
      <p className="memory-note">
        {GOAL_LABEL[draft.goal]} · {draft.format === "thread" ? "Thread" : "Post"} · {draft.tone} · {draft.length}
        {trend && (
          <>
            {" "}
            · from the trend <Link href={`/trends/${trend.id}`}>{trend.label}</Link>
          </>
        )}
      </p>
      {draft.idea && <p className="memory-note">Idea: {draft.idea.hook}</p>}
      {draft.archivedAt && <p className="form-message">Archived: it&apos;s hidden from Studio and the calendar until you unarchive it.</p>}
      <DraftEditor
        draftId={draft.id}
        format={draft.format}
        initialTitle={draft.title}
        initialPosts={draft.posts}
        initialStatus={draft.status}
        initialReview={draft.review}
        publishedConfirmed={Boolean(draft.publishedConfirmedAt)}
      />
      {(showPublication || canApprove) && (
        <section className="crm-panel" aria-labelledby="publish-title">
          <h2 id="publish-title">Publish on X</h2>
          {showPublication ? (
            <PublishCard
              returnTo={`/studio/${draft.id}`}
              item={{
                label: publication.status === "scheduled" && publication.scheduledAt ? "Scheduled" : PUBLICATION_LABEL[publication.status],
                text: publication.text,
                why: publication.error ?? (publication.hasUrl ? "Has a link: X charges $0.20 to publish a post with a link ($0.015 without)." : "You approved this exact text."),
                meta: undefined,
              }}
              publication={toPublicationCard(publication, publishing, tz, new Date(), draft.publishedUrl)}
            />
          ) : (
            <ApproveForPublishing draftId={draft.id} />
          )}
        </section>
      )}
      <section className="crm-panel" aria-labelledby="plan-title">
        <h2 id="plan-title">
          Calendar · {LIFECYCLE_LABEL[state]}
          {plannedParts && ` · ${plannedParts.date} ${plannedParts.time} (${tz})`}
        </h2>
        {draft.planNote && <p className="memory-note">Note: {draft.planNote}</p>}
        <PlanForm
          draftId={draft.id}
          initial={{
            date: plannedParts?.date ?? zonedParts(new Date(), tz).date,
            time: plannedParts?.time ?? "09:00",
            timeZone: tz,
            goal: draft.goal,
            note: draft.planNote ?? "",
            planned: Boolean(draft.plannedAt),
            archived: Boolean(draft.archivedAt),
          }}
        />
        <PublishedUrlForm draftId={draft.id} initial={draft.publishedUrl ?? ""} />
      </section>
      <InfoHint text="About [brackets]">
        Square brackets like [your example] mark things only you know: fill them in before posting. Scout doesn&apos;t invent
        experiences, numbers or testimonials.
      </InfoHint>
    </main>
  );
}
