import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { AutomationBuilder, type BuilderValue } from "@/components/automations/AutomationBuilder";
import { AutomationRowControls, MarkReadButton, ReviewItemControls } from "@/components/automations/AutomationControls";
import { EmptyState } from "@/components/EmptyState";
import { TitleWithHint } from "@/components/InfoHint";
import { getAutomation } from "@/db/queries/automations";
import { getProfileTimeZone } from "@/db/queries/content";
import { isMissingSchemaError } from "@/db/schemaErrors";
import { requireProfile } from "@/lib/auth/session";
import { dueLabel } from "@/lib/automations/format";
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import { ACTION_INFO, type AutomationConditions, TRIGGER_INFO } from "@/lib/automations/types";
import { isValidTimeZone, zonedParts } from "@/lib/content/calendar";
import { formatRelative } from "@/lib/format";
import { loadAutomationsView } from "@/services/automations/manage";

export const metadata: Metadata = { title: "Automations" };

export default function AutomationsPage({ searchParams }: PageProps<"/automations">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Automations searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const EMPTY: BuilderValue = {
  name: "",
  description: "",
  trigger: "new_opportunity",
  conditions: {},
  actions: ["notify"],
  enabled: true,
  templateKey: null,
};

function conditionText(conditions: AutomationConditions): string {
  const parts: string[] = [];
  if (conditions.minScore !== undefined) parts.push(`score ≥ ${conditions.minScore}`);
  if (conditions.minRelevance !== undefined) parts.push(`relevance ≥ ${conditions.minRelevance}`);
  if (conditions.textContains) parts.push(`mentions "${conditions.textContains}"`);
  if (conditions.maxAgeHours !== undefined) parts.push(`under ${conditions.maxAgeHours} h old`);
  if (conditions.intents?.length) parts.push(`intent ${conditions.intents.join("/")}`);
  if (conditions.leadStatuses?.length) parts.push(`CRM ${conditions.leadStatuses.join("/")}`);
  if (conditions.trendStatuses?.length) parts.push(conditions.trendStatuses.join("/").replace(/_/g, " "));
  if (conditions.minConfidence) parts.push(`confidence ≥ ${conditions.minConfidence}`);
  if (conditions.contentFormats?.length) parts.push(conditions.contentFormats.join("/"));
  if (conditions.contentStatuses?.length) parts.push(conditions.contentStatuses.join("/"));
  if (conditions.taskModules?.length) parts.push(`tasks in ${conditions.taskModules.join("/")}`);
  return parts.length ? parts.join(", ") : "always";
}

async function Automations({ searchParams }: { searchParams: PageProps<"/automations">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

  let view: Awaited<ReturnType<typeof loadAutomationsView>>;
  try {
    view = await loadAutomationsView(profile);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    console.error("Automations are unavailable: the database is missing migration 'automation_scout'.");
    return (
      <main className="workspace shell enter-content">
        <EmptyState title="Automations need a database update." description="This version of Scout expects database changes that haven't been applied yet. Your data is safe." />
      </main>
    );
  }

  // The builder: a template, an automation being edited, or empty
  const template = AUTOMATION_TEMPLATES.find((t) => t.key === one(params.template));
  const editing = /^[0-9a-f-]{36}$/i.test(one(params.edit)) ? await getAutomation(profile.id, one(params.edit)) : undefined;
  const initial: BuilderValue = editing
    ? { name: editing.name, description: editing.description ?? "", trigger: editing.trigger, conditions: editing.conditions, actions: editing.actions, enabled: editing.enabled, templateKey: editing.templateKey }
    : template
      ? { name: template.name, description: template.description, trigger: template.trigger, conditions: template.conditions, actions: template.actions, enabled: true, templateKey: template.key }
      : EMPTY;
  const unread = view.notifications.filter((n) => !n.readAt);
  // Plan reminders are due on a day in the user's time zone
  const savedTz = await getProfileTimeZone(profile.id);
  const today = zonedParts(new Date(), savedTz && isValidTimeZone(savedTz) ? savedTz : "UTC").date;

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <TitleWithHint
            title="Automations"
            hint={
              <>
                Automations watch what Scout already found (opportunities, leads, trends, your CRM, calendar and growth plan) and
                notify you, remind you or put items in your review queue. They never call X, and never post, reply, send messages or
                follow anyone for you. AI drafts run only when you turn them on, from your plan&apos;s AI budget.
              </>
            }
          />
          <p className="lede">Let Scout keep an eye on things for you.</p>
        </div>
      </section>

      {view.paused && <p className="strategy-banner" data-kind="starter">Automations are paused across Scout right now. Nothing runs until they&apos;re resumed.</p>}

      <section className="stat-cards" aria-label="Automation overview">
        <div className="stat-card">
          <span className="stat-card-label">Active automations</span>
          <strong>
            {view.usage.active} / {view.usage.activeLimit}
          </strong>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Runs this month</span>
          <strong>
            {view.usage.used} / {view.usage.limit}
          </strong>
          <small>Counted when an event matches and actions run</small>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">To review</span>
          <strong>{view.queue.length}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Unread notifications</span>
          <strong>{unread.length}</strong>
        </div>
      </section>

      <section className="dash-card" aria-labelledby="queue-title">
        <div className="dash-card-head">
          <h2 id="queue-title">Review queue</h2>
        </div>
        {view.queue.length === 0 ? (
          <p className="memory-note">Nothing waiting for you.</p>
        ) : (
          <ul className="automation-list">
            {view.queue.map((item) => (
              <li key={item.id} className="automation-row">
                <div className="peer-main">
                  <strong>{item.title}</strong>
                  <span className="strategy-pill">{item.kind === "reminder" ? "Reminder" : "Review"}</span>
                  {item.body && <p className="memory-note">{item.body}</p>}
                  <p className="memory-note">
                    {item.sourceModule} · {dueLabel(item, today, formatRelative)} ·{" "}
                    <Link href={item.href} className="text-link">
                      Open
                    </Link>
                  </p>
                </div>
                <ReviewItemControls id={item.id} kind={item.kind === "reminder" ? "reminder" : "review"} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.notifications.length > 0 && (
        <section className="dash-card" aria-labelledby="notifications-title">
          <div className="dash-card-head">
            <h2 id="notifications-title">Notifications</h2>
            {unread.length > 0 && <MarkReadButton />}
          </div>
          <ul className="automation-list">
            {view.notifications.slice(0, 10).map((n) => (
              <li key={n.id} className="automation-row" data-unread={n.readAt ? undefined : ""}>
                <div className="peer-main">
                  <strong>{n.title}</strong>
                  <p className="memory-note">
                    {n.sourceModule} · {formatRelative(n.createdAt)} ·{" "}
                    <Link href={n.href} className="text-link">
                      Open
                    </Link>
                  </p>
                </div>
                {!n.readAt && <MarkReadButton id={n.id} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="dash-card" aria-labelledby="mine-title">
        <div className="dash-card-head">
          <h2 id="mine-title">My automations</h2>
        </div>
        {view.automations.length === 0 ? (
          <p className="memory-note">None yet. Start from a template below, or build your own.</p>
        ) : (
          <ul className="automation-list">
            {view.automations.map(({ automation, runsThisMonth }) => (
              <li key={automation.id} className="automation-row">
                <div className="peer-main">
                  <strong>{automation.name}</strong>
                  <span className="strategy-pill">{automation.enabled ? "On" : "Off"}</span>
                  <p className="memory-note">
                    <b>When</b> {TRIGGER_INFO[automation.trigger].label.toLowerCase()} · <b>if</b> {conditionText(automation.conditions)} · <b>then</b>{" "}
                    {automation.actions.map((a) => ACTION_INFO[a].label.split(" (")[0].toLowerCase()).join(", ")}
                  </p>
                  <p className="memory-note">
                    {runsThisMonth} runs this month · last run {automation.lastRunAt ? formatRelative(automation.lastRunAt) : "not yet"}
                    {automation.lastError && <span className="automation-error"> · {automation.lastError}</span>}
                  </p>
                </div>
                <AutomationRowControls id={automation.id} name={automation.name} enabled={automation.enabled} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dash-card" aria-labelledby="builder" id="builder">
        <div className="dash-card-head">
          <h2>{editing ? `Edit "${editing.name}"` : template ? `New from template: ${template.name}` : "Create an automation"}</h2>
          {(editing || template) && (
            <Link href="/automations#builder" className="text-link">
              Start empty
            </Link>
          )}
        </div>
        <AutomationBuilder key={editing?.id ?? template?.key ?? "new"} initial={initial} editId={editing?.id} />
      </section>

      <section className="dash-card" aria-labelledby="templates-title">
        <div className="dash-card-head">
          <h2 id="templates-title">Templates</h2>
        </div>
        <ul className="automation-templates">
          {AUTOMATION_TEMPLATES.map((t) => (
            <li key={t.key}>
              <strong>{t.name}</strong>
              <p className="memory-note">{t.description}</p>
              <Link href={`/automations?template=${t.key}#builder`} className="text-link">
                Use this template <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="dash-card" aria-labelledby="activity-title">
        <div className="dash-card-head">
          <h2 id="activity-title">Activity</h2>
        </div>
        {view.activity.length === 0 ? (
          <p className="memory-note">No runs yet. Automations check for new events every few minutes.</p>
        ) : (
          <ul className="automation-list">
            {view.activity.map(({ run, name }) => (
              <li key={run.id} className="automation-activity" data-status={run.status}>
                <span className="strategy-pill">{run.status}</span> <strong>{name}</strong> · {formatRelative(run.updatedAt)}
                {run.reason && <span className="memory-note"> · {run.reason}</span>}
                {run.actionResults.length > 0 && (
                  <span className="memory-note"> · {run.actionResults.map((r) => `${r.action.replace(/_/g, " ")}: ${r.status}${r.note ? ` (${r.note})` : ""}`).join("; ")}</span>
                )}
                {run.aiCostUsd ? <span className="memory-note"> · AI ${run.aiCostUsd.toFixed(3)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
