import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { AppHeader } from "@/components/AppHeader";
import { LeadWorkspace } from "@/components/crm/LeadWorkspace";
import { StatusSelect } from "@/components/crm/StatusSelect";
import { InfoHint } from "@/components/InfoHint";
import { getCrmLead } from "@/db/queries/crm";
import type { LeadActivity } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { followUpState, nextBestAction, STATUS_LABEL } from "@/lib/leads/crm";

export const metadata: Metadata = { title: "Lead" };

const INTENT_LABEL = { high: "High intent", medium: "Medium intent", low: "Low intent" } as const;

/** What each timeline entry says; user-entered ones are marked as such */
function describe(activity: LeadActivity): string {
  const d = activity.detail ?? {};
  switch (activity.kind) {
    case "saved":
      return "Saved to your CRM";
    case "status_changed":
      return `Status: ${STATUS_LABEL[d.from as keyof typeof STATUS_LABEL] ?? d.from} → ${STATUS_LABEL[d.to as keyof typeof STATUS_LABEL] ?? d.to}`;
    case "note_added":
      return "Note added";
    case "reply_started":
      return "Reply drafts opened in Scout";
    case "x_opened":
      return "Post opened on X (not a contact)";
    case "contact_logged":
      return "You contacted them";
    case "response_logged":
      return "They responded";
    case "follow_up_set":
      return `Follow-up set for ${d.date}`;
    case "follow_up_done":
      return "Follow-up done";
    case "new_signal":
      return `New post with ${d.intent} buying intent: “${d.evidence}”`;
  }
}

export default function CrmLeadPage(props: PageProps<"/crm/[id]">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <LeadDetail {...props} />
      </Suspense>
    </div>
  );
}

async function LeadDetail({ params }: PageProps<"/crm/[id]">) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const data = await getCrmLead(profile.id, id);
  if (!data) notFound();
  const { lead, notes, activities } = data;
  const b = lead.scoreBreakdown;
  const now = new Date();
  const next = nextBestAction(
    {
      status: lead.status,
      intent: lead.intent,
      postedAt: lead.postedAt,
      followUpAt: lead.followUpAt,
      followUpDoneAt: lead.followUpDoneAt,
      lastActivityAt: lead.lastActivityAt,
      activityKinds: activities.map((activity) => activity.kind),
    },
    now,
  );
  const followUp = followUpState(lead.followUpAt, lead.followUpDoneAt, now);

  return (
    <main className="workspace shell enter-content">
      <p className="eyebrow">
        <Link href="/crm">← Pipeline</Link>
      </p>
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">
            {lead.score} · {INTENT_LABEL[lead.intent]}
            {!lead.saved && " · not in your CRM"}
          </p>
          <h1>
            <a href={`https://x.com/${encodeURIComponent(lead.authorHandle)}`} target="_blank" rel="noreferrer">
              @{lead.authorHandle}
            </a>
          </h1>
          <StatusSelect leadId={lead.id} status={lead.status} />
        </div>
      </section>

      {next && (
        <p className="crm-next-banner" data-tone={next.tone} role="status">
          <strong>Next step:</strong> {next.text}
        </p>
      )}

      <div className="discovery-layout">
        <section aria-labelledby="signal-title">
          <h2 id="signal-title" className="eyebrow">
            The post that found them · {formatRelative(lead.postedAt)}
          </h2>
          <blockquote className="opportunity-post">{lead.content}</blockquote>
          <InfoHint text="About this data">
            Saved from public X data. If the post was deleted on X the link won&apos;t open, but what Scout saw stays here.
          </InfoHint>
          <section className="opportunity-section">
            <h3>Why it&apos;s a lead</h3>
            <p>{lead.reason}</p>
            <p className="lead-evidence">&ldquo;{lead.evidence}&rdquo;</p>
          </section>
          <section className="opportunity-section">
            <h3>Suggested next step from the scan</h3>
            <p>{lead.suggestedAction}</p>
          </section>
          <InfoHint text="Score breakdown">
            Lead score {lead.score}: customer fit {b.icpFit}/30 · intent {b.intentStrength}/35 · problem fit {b.problemFit}/20 ·
            evidence {b.evidence}/10 · recency {b.recency}/5. A ranking aid, not a chance of buying.
          </InfoHint>

          <section className="crm-panel" aria-labelledby="timeline-title">
            <h2 id="timeline-title">Timeline</h2>
            <ol className="crm-timeline">
              {activities.map((activity) => (
                <li key={activity.id} data-user={activity.userEntered || undefined}>
                  <span>{describe(activity)}</span>
                  <small>
                    {formatRelative(activity.createdAt)}
                    {activity.userEntered ? " · recorded by you" : " · seen by Scout"}
                  </small>
                </li>
              ))}
              <li>
                <span>Found by Lead Scout</span>
                <small>{formatRelative(lead.createdAt)} · seen by Scout</small>
              </li>
            </ol>
          </section>
        </section>

        <LeadWorkspace
          leadId={lead.id}
          postUrl={lead.postUrl}
          saved={lead.saved}
          followUpDate={lead.followUpAt ? lead.followUpAt.toISOString().slice(0, 10) : null}
          followUpNote={lead.followUpNote}
          followUpPending={followUp !== "none"}
          notes={notes.map((note) => ({
            id: note.id,
            body: note.body,
            createdLabel: formatRelative(note.createdAt),
            edited: note.updatedAt.getTime() - note.createdAt.getTime() > 1000,
          }))}
        />
      </div>
    </main>
  );
}
