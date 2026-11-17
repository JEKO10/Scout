import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { StatusSelect } from "@/components/crm/StatusSelect";
import { EmptyState } from "@/components/EmptyState";
import { TitleWithHint } from "@/components/InfoHint";
import { type CrmSort, getActivityKinds, getCrmLeads, getCrmMetrics, getFollowUps } from "@/db/queries/crm";
import type { Lead } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";
import { effectiveLimits } from "@/lib/billing/plans";
import { formatRelative } from "@/lib/format";
import { followUpState, LEAD_STATUSES, type LeadStatus, nextBestAction, STATUS_LABEL } from "@/lib/leads/crm";
import { LEAD_INTENTS, type LeadIntent } from "@/lib/leads/types";

export const metadata: Metadata = { title: "Lead CRM" };

const SORTS: { value: CrmSort; label: string }[] = [
  { value: "score", label: "Lead score" },
  { value: "intent", label: "Intent" },
  { value: "recent", label: "Newest" },
  { value: "follow_up", label: "Follow-up date" },
];
const INTENT_LABEL: Record<LeadIntent, string> = { high: "High", medium: "Medium", low: "Low" };
const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

export default function CrmPage({ searchParams }: PageProps<"/crm">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Crm searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Crm({ searchParams }: { searchParams: PageProps<"/crm">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

  const q = one(params.q).trim().slice(0, 80);
  const status = (LEAD_STATUSES as readonly string[]).includes(one(params.status)) ? (one(params.status) as LeadStatus) : undefined;
  const intent = (LEAD_INTENTS as readonly string[]).includes(one(params.intent)) ? (one(params.intent) as LeadIntent) : undefined;
  const sort = SORTS.some((s) => s.value === one(params.sort)) ? (one(params.sort) as CrmSort) : "score";
  const view = one(params.view) === "kanban" ? "kanban" : "list";

  const [leads, metrics, followUps] = await Promise.all([
    getCrmLeads(profile.id, { q: q || undefined, status, intent, sort }),
    getCrmMetrics(profile.id),
    getFollowUps(profile.id),
  ]);
  const kinds = await getActivityKinds(profile.id, leads.map((lead) => lead.id));
  const now = new Date();
  const action = (lead: Lead) =>
    nextBestAction(
      {
        status: lead.status,
        intent: lead.intent,
        postedAt: lead.postedAt,
        followUpAt: lead.followUpAt,
        followUpDoneAt: lead.followUpDoneAt,
        lastActivityAt: lead.lastActivityAt,
        activityKinds: kinds.get(lead.id) ?? [],
      },
      now,
    );
  const filtered = Boolean(q || status || intent);
  const viewHref = (next: "list" | "kanban") => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (status) search.set("status", status);
    if (intent) search.set("intent", intent);
    if (sort !== "score") search.set("sort", sort);
    if (next === "kanban") search.set("view", "kanban");
    const query = search.toString();
    return query ? `/crm?${query}` : "/crm";
  };
  const max = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxSavedLeads;
  const closed = metrics.won + metrics.lost;

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <TitleWithHint
            title="CRM"
            hint={
              <>
                Leads you saved from <Link href="/leads">Lead Scout</Link>, where they stand, and what to do next. Statuses and contacts are what you record; Scout never messages anyone.
              </>
            }
          />
          <p className="lede">Your pipeline.</p>
        </div>
      </section>

      <section className="metrics-strip crm-metrics" aria-label="Pipeline">
        <Metric value={`${metrics.saved} / ${max}`} label="Saved leads" />
        <Metric value={metrics.high} label="High intent" />
        <Metric value={metrics.awaiting} label="Awaiting action" />
        <Metric value={metrics.followUpsDue} label="Follow-ups due" />
        <Metric value={metrics.qualified} label="Qualified" />
        <Metric value={metrics.won} label="Won" />
      </section>
      <p className="memory-note">
        Contacted (your records): {metrics.contacted} · Follow-ups completed: {metrics.followUpsCompleted}
        {metrics.contacted >= 5 && ` · Qualified of contacted: ${Math.round((metrics.qualified / metrics.contacted) * 100)}%`}
        {closed >= 3 && ` · Won of closed: ${Math.round((metrics.won / closed) * 100)}%`}
      </p>

      {followUps.length > 0 && (
        <section className="crm-panel crm-followups" aria-labelledby="followups-title">
          <h2 id="followups-title">Follow-ups</h2>
          <ul>
            {followUps.map((lead) => {
              const state = followUpState(lead.followUpAt, lead.followUpDoneAt, now);
              return (
                <li key={lead.id} data-state={state}>
                  <span className="crm-followup-when">
                    {state === "overdue" ? "Overdue" : state === "today" ? "Today" : day.format(lead.followUpAt!)}
                  </span>
                  <Link href={`/crm/${lead.id}`}>@{lead.authorHandle}</Link>
                  {lead.followUpNote && <span className="memory-note"> · {lead.followUpNote}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <form className="discovery-filters" method="get">
        <label>
          Search
          <input name="q" defaultValue={q} placeholder="Handle or words in the post" className="crm-search" />
        </label>
        <label>
          Status
          <select name="status" defaultValue={status ?? ""}>
            <option value="">All</option>
            {LEAD_STATUSES.map((option) => (
              <option key={option} value={option}>
                {STATUS_LABEL[option]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Intent
          <select name="intent" defaultValue={intent ?? ""}>
            <option value="">All</option>
            {LEAD_INTENTS.map((option) => (
              <option key={option} value={option}>
                {INTENT_LABEL[option]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select name="sort" defaultValue={sort}>
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {view === "kanban" && <input type="hidden" name="view" value="kanban" />}
        <button type="submit" className="secondary-button">
          Apply
        </button>
        {filtered && (
          <Link href={view === "kanban" ? "/crm?view=kanban" : "/crm"} className="text-link">
            Clear
          </Link>
        )}
        <span className="crm-view-toggle" role="group" aria-label="View">
          <Link href={viewHref("list")} aria-current={view === "list" ? "page" : undefined}>
            List
          </Link>
          <Link href={viewHref("kanban")} aria-current={view === "kanban" ? "page" : undefined}>
            Kanban
          </Link>
        </span>
      </form>

      {leads.length === 0 ? (
        <EmptyState
          title={filtered ? "No saved leads match." : "No saved leads yet."}
          description={
            filtered
              ? "Try another search or clear the filters."
              : "Save leads from Lead Scout to track them here: status, notes, follow-ups and what to do next."
          }
          action={{ href: "/leads", label: "Open Lead Scout" }}
        />
      ) : view === "list" ? (
        <div className="analytics-table-wrap">
          <table className="analytics-table crm-table">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Score</th>
                <th>Intent</th>
                <th>Status</th>
                <th>Last activity</th>
                <th>Follow-up</th>
                <th>Next step</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const next = action(lead);
                return (
                  <tr key={lead.id}>
                    <td>
                      <Link href={`/crm/${lead.id}`}>@{lead.authorHandle}</Link>
                    </td>
                    <td>{lead.score}</td>
                    <td>{INTENT_LABEL[lead.intent]}</td>
                    <td>
                      <StatusSelect leadId={lead.id} status={lead.status} label={`Status of @${lead.authorHandle}`} />
                    </td>
                    <td>{lead.lastActivityAt ? formatRelative(lead.lastActivityAt) : "–"}</td>
                    <td>{lead.followUpAt && followUpState(lead.followUpAt, lead.followUpDoneAt, now) !== "none" ? day.format(lead.followUpAt) : "–"}</td>
                    <td className="crm-next" data-tone={next?.tone}>
                      {next?.text ?? "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="crm-kanban">
          {LEAD_STATUSES.map((column) => {
            const items = leads.filter((lead) => lead.status === column);
            return (
              <section key={column} className="crm-column" aria-label={STATUS_LABEL[column]}>
                <h2>
                  {STATUS_LABEL[column]} <span>{items.length}</span>
                </h2>
                {items.map((lead) => (
                  <article key={lead.id} className="crm-card">
                    <Link href={`/crm/${lead.id}`}>@{lead.authorHandle}</Link>
                    <p>
                      {lead.score} · {INTENT_LABEL[lead.intent]} intent
                    </p>
                    <StatusSelect leadId={lead.id} status={lead.status} label={`Move @${lead.authorHandle}`} />
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
