import "server-only";

import {
  aiCostSince,
  claimAutomation,
  claimRetry,
  contentDue,
  countCountedRuns,
  countEnabledAutomations,
  finishRun,
  followUpsDue,
  getRunsByKeys,
  insertItem,
  leadsAfter,
  listAutomations,
  nextAutomations,
  opportunitiesAfter,
  releaseAutomation,
  retryableRuns,
  startRun,
  strategyTasksDue,
  trendsAfter,
} from "@/db/queries/automations";
import { getProfileTimeZone } from "@/db/queries/content";
import { ensureLeadOpportunity, getLead, setLeadSaved } from "@/db/queries/leads";
import { setOpportunityStatus } from "@/db/queries/opportunities";
import { getProfileById } from "@/db/queries/profiles";
import { getCurrentReplies, getLastReplyStyles } from "@/db/queries/replies";
import type { Automation, AutomationRun, Profile } from "@/db/schema";
import { isMissingSchemaError } from "@/db/schemaErrors";
import { type AutomationEvent,matchConditions } from "@/lib/automations/rules";
import { type AutomationAction, type AutomationActionResult, MAX_RUN_ATTEMPTS } from "@/lib/automations/types";
import { effectiveLimits } from "@/lib/billing/plans";
import { isValidTimeZone, zonedParts } from "@/lib/content/calendar";
import { REPLY_STYLES, type ReplyStyle } from "@/lib/replies/styles";
import { MODULE_LINK, type StrategyModule } from "@/lib/strategy/types";
import { currentPeriodStart } from "@/services/billing/budget";
import { generateReplies } from "@/services/replies/generateReply";
import { generateTrendInsight } from "@/services/trends/insight";

// Day 36 Automation Scout engine. Runs from the scheduler tick (Vercel Cron,
// every 5 minutes): bounded batches, all state in Postgres, no in-memory
// queues. Events come from data Scout modules already stored; nothing here
// calls X, and nothing is ever posted, replied, sent or followed on X.

export const ENGINE = {
  /** Automations per tick */
  maxAutomations: 25,
  /** New events read per automation per tick */
  maxEventsPerAutomation: 25,
  /** Due-type triggers look back this far (a missed tick doesn't lose a reminder) */
  dueLookbackDays: 3,
  /** One automation's lock; a crashed worker's expires */
  lockMinutes: 5,
  /** AI actions are cut off after this */
  actionTimeoutMs: 45_000,
  /** How far the "new events" cursor stays behind now */
  cursorLagMs: 2 * 60_000,
  /** Retry delay: 5, 10, 20 minutes */
  retryBaseMinutes: 5,
};

const DAY = 86_400_000;

/** Global kill switch: AUTOMATIONS_KILL_SWITCH=true stops all automation execution */
export function automationsPaused(): boolean {
  return process.env.AUTOMATIONS_KILL_SWITCH === "true";
}

// ---- Events --------------------------------------------------------------------------

const hoursSince = (date: Date | null | undefined, now: Date) => (date ? (now.getTime() - date.getTime()) / 3_600_000 : null);
const short = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function localDay(profileId: string, now: Date): Promise<{ today: string; tz: string }> {
  const saved = await getProfileTimeZone(profileId);
  const tz = saved && isValidTimeZone(saved) ? saved : "UTC";
  return { today: zonedParts(now, tz).date, tz };
}

function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Events for an automation, from stored data only. "New" triggers read past
 * the automation's cursor (bounded, oldest first); due triggers look at a
 * short window up to now. `ids`: reload specific entities (retries).
 */
export async function eventsFor(automation: Automation, now: Date, ids?: string[]): Promise<AutomationEvent[]> {
  const limit = ENGINE.maxEventsPerAutomation;
  const pid = automation.profileId;
  const from = new Date(now.getTime() - ENGINE.dueLookbackDays * DAY);
  switch (automation.trigger) {
    case "new_opportunity":
      return (await opportunitiesAfter(pid, automation.cursorAt, limit, ids)).map((o) => ({
        trigger: "new_opportunity",
        key: `opportunity:${o.id}`,
        entityId: o.id,
        at: o.createdAt,
        title: `New opportunity${o.authorHandle ? ` from @${o.authorHandle}` : ""}${o.score !== null ? ` (score ${Math.round(o.score)})` : ""}`,
        body: short(o.content),
        href: `/opportunities/${o.id}`,
        sourceModule: "Opportunities",
        entityType: "opportunity",
        facts: { score: o.score, text: [o.topic, o.content].filter(Boolean).join(" "), ageHours: hoursSince(o.postedAt ?? o.createdAt, now) },
      }));
    case "high_intent_lead":
      return (await leadsAfter(pid, automation.cursorAt, limit, ids)).map((l) => ({
        trigger: "high_intent_lead",
        key: `lead:${l.id}`,
        entityId: l.id,
        at: l.createdAt,
        title: `${l.intent === "high" ? "High-intent" : l.intent === "medium" ? "Possible" : "Low-intent"} lead: @${l.authorHandle} (score ${l.score})`,
        body: short(l.reason),
        href: `/crm/${l.id}`,
        sourceModule: "Lead Scout",
        entityType: "lead",
        facts: { score: l.score, intent: l.intent, leadStatus: l.status, text: l.content, ageHours: hoursSince(l.postedAt, now) },
      }));
    case "relevant_trend":
      return (await trendsAfter(pid, automation.cursorAt, limit, ids)).map((t) => ({
        trigger: "relevant_trend",
        key: `trend:${t.id}`,
        entityId: t.id,
        at: t.updatedAt,
        title: `Trend: ${t.label} (${t.status.replace("_", " ")})`,
        body: t.summary ? short(t.summary) : `${t.postCount} posts from ${t.authorCount} accounts`,
        href: `/trends/${t.id}`,
        sourceModule: "Trend Scout",
        entityType: "trend",
        facts: { relevance: t.relevance, trendStatus: t.status, confidence: t.confidence, text: t.label, ageHours: hoursSince(t.lastPostAt, now) },
      }));
    case "followup_due":
      return (await followUpsDue(pid, from, now, limit, ids))
        .filter((l) => l.followUpAt)
        .map((l) => ({
          trigger: "followup_due",
          // A rescheduled follow-up is a new event
          key: `followup:${l.id}:${l.followUpAt!.getTime()}`,
          entityId: l.id,
          at: l.followUpAt!,
          title: `Follow up with @${l.authorHandle}`,
          body: l.followUpNote ? short(l.followUpNote) : null,
          href: `/crm/${l.id}`,
          sourceModule: "CRM",
          entityType: "lead",
          facts: { score: l.score, intent: l.intent, leadStatus: l.status },
        }));
    case "content_due":
      return (await contentDue(pid, from, now, limit, ids))
        .filter((d) => d.plannedAt)
        .map((d) => ({
          trigger: "content_due",
          key: `content:${d.id}:${d.plannedAt!.getTime()}`,
          entityId: d.id,
          at: d.plannedAt!,
          title: `Planned ${d.format}: ${short(d.title, 80)}`,
          body: "Due now. Open it, post it on X yourself, then mark it posted.",
          href: `/studio/${d.id}`,
          sourceModule: "Content Calendar",
          entityType: "content",
          facts: { contentFormat: d.format, contentStatus: d.status },
        }));
    case "strategy_task_due": {
      const { today } = await localDay(pid, now);
      const rows = await strategyTasksDue(pid, shiftDay(today, -2), today, limit, ids);
      return rows.map(({ task }) => {
        const link = MODULE_LINK[task.module as StrategyModule];
        return {
          trigger: "strategy_task_due" as const,
          key: `task:${task.id}:${task.day}`,
          entityId: task.id,
          at: new Date(`${task.day}T00:00:00Z`),
          title: `Growth plan: ${short(task.title, 90)} (~${task.effortMinutes} min)`,
          body: short(task.activity, 200),
          href: link?.href ?? "/strategy",
          sourceModule: link?.label ?? "Growth Strategy",
          entityType: "strategy_task" as const,
          facts: { taskModule: task.module },
        };
      });
    }
  }
}

// ---- Actions -------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}

/** The styles of the last generation, else the first two: also used by the Day 38 inbox */
export async function replyStyles(profileId: string): Promise<[ReplyStyle, ReplyStyle]> {
  const last = await getLastReplyStyles(profileId);
  const styles = [...new Set([...(last ?? []), ...REPLY_STYLES])].slice(0, 2) as ReplyStyle[];
  return [styles[0], styles[1]];
}

/**
 * Two reply drafts for an opportunity (a lead uses the opportunity behind
 * it), unless drafts already exist. From the plan's writing budget. A draft
 * is never sent: the user reviews it and posts it on X themselves.
 */
async function prepareReplyDraft(profile: Profile, event: AutomationEvent): Promise<AutomationActionResult> {
  let opportunityId = event.entityId;
  if (event.entityType === "lead") {
    const lead = await getLead(profile.id, event.entityId);
    if (!lead) return { action: "ai_reply_draft", status: "skipped", note: "lead not found" };
    const id = await ensureLeadOpportunity(profile.id, lead);
    if (!id) return { action: "ai_reply_draft", status: "skipped", note: "no conversation to reply to" };
    opportunityId = id;
  }
  if ((await getCurrentReplies(profile.id, [opportunityId])).size > 0) {
    return { action: "ai_reply_draft", status: "skipped", note: "drafts already exist" };
  }
  const result = await withTimeout(generateReplies(profile.id, opportunityId, { styles: await replyStyles(profile.id) }), ENGINE.actionTimeoutMs);
  if (result.status === "generated") return { action: "ai_reply_draft", status: "done", note: "2 drafts ready to review (not sent)" };
  if (result.status === "budget_exhausted") return { action: "ai_reply_draft", status: "skipped", note: "AI writing budget used up" };
  return { action: "ai_reply_draft", status: "skipped", note: result.status === "no_brain" ? "Scout Brain missing" : "not found" };
}

async function prepareContentAngle(profile: Profile, event: AutomationEvent): Promise<AutomationActionResult> {
  const result = await withTimeout(generateTrendInsight(profile, event.entityId), ENGINE.actionTimeoutMs);
  if (result.ok) return { action: "ai_content_angle", status: "done", note: result.cached ? "angles already prepared" : "angles prepared" };
  return { action: "ai_content_angle", status: "skipped", note: result.message.slice(0, 120) };
}

async function runAction(action: AutomationAction, ctx: { profile: Profile; automation: Automation; run: AutomationRun; event: AutomationEvent }): Promise<AutomationActionResult> {
  const { profile, automation, run, event } = ctx;
  const item = (kind: "notification" | "review" | "reminder") =>
    insertItem({
      profileId: profile.id,
      automationId: automation.id,
      runId: run.id,
      kind,
      eventKey: event.key,
      sourceModule: event.sourceModule,
      entityType: event.entityType,
      entityId: event.entityId,
      title: event.title,
      body: event.body,
      href: event.href,
      dueAt: kind === "reminder" ? event.at : null,
    });
  switch (action) {
    case "notify":
      await item("notification");
      return { action, status: "done" };
    case "review":
      await item("review");
      return { action, status: "done" };
    case "reminder":
      await item("reminder");
      return { action, status: "done" };
    case "save_opportunity":
      if (event.entityType !== "opportunity") return { action, status: "skipped", note: "not an opportunity" };
      return (await setOpportunityStatus(profile.id, event.entityId, "saved")) ? { action, status: "done" } : { action, status: "skipped", note: "opportunity gone" };
    case "save_lead":
      if (event.entityType !== "lead") return { action, status: "skipped", note: "not a lead" };
      return (await setLeadSaved(profile.id, event.entityId, true)) ? { action, status: "done" } : { action, status: "skipped", note: "lead gone" };
    case "ai_reply_draft":
      if (event.entityType !== "opportunity" && event.entityType !== "lead") return { action, status: "skipped", note: "nothing to reply to" };
      return prepareReplyDraft(profile, event);
    case "ai_content_angle":
      if (event.entityType !== "trend") return { action, status: "skipped", note: "not a trend" };
      return prepareContentAngle(profile, event);
  }
}

// ---- Runner --------------------------------------------------------------------------

export type AutomationTickResult = {
  paused?: true;
  automations: number;
  succeeded: number;
  skipped: number;
  failed: number;
  retried: number;
};

/**
 * Executes one event for one automation. The run row is created first (the
 * unique (automation, event) key makes this the idempotency guard), then
 * the actions run in order; a non-AI action that throws fails the run, to
 * be retried with backoff up to 3 attempts. Items are unique per run and
 * kind, so a retry never duplicates a notification or reminder.
 */
async function execute(profile: Profile, automation: Automation, event: AutomationEvent, run: AutomationRun): Promise<"succeeded" | "failed"> {
  const started = Date.now();
  const since = new Date(started - 1000);
  const results: AutomationActionResult[] = [];
  let error: string | null = null;
  for (const action of automation.actions) {
    try {
      results.push(await runAction(action, { profile, automation, run, event }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message.slice(0, 160) : "error";
      results.push({ action, status: "failed", note: message });
      // AI actions are optional extras: their failure doesn't fail (or repeat) the run
      if (action !== "ai_reply_draft" && action !== "ai_content_angle") error = `${action}: ${message}`;
    }
  }
  const usedAi = results.some((r) => (r.action === "ai_reply_draft" || r.action === "ai_content_angle") && r.status === "done");
  const aiCostUsd = usedAi ? await aiCostSince(profile.id, since) : null;
  const retry = error && run.attempts < MAX_RUN_ATTEMPTS;
  await finishRun(run.id, {
    status: error ? "failed" : "succeeded",
    reason: error,
    actionResults: results,
    aiCostUsd,
    durationMs: Date.now() - started,
    nextRetryAt: retry ? new Date(Date.now() + ENGINE.retryBaseMinutes * 2 ** (run.attempts - 1) * 60_000) : null,
  });
  return error ? "failed" : "succeeded";
}

async function processAutomation(automation: Automation, now: Date, result: AutomationTickResult): Promise<void> {
  const profile = await getProfileById(automation.profileId);
  if (!profile) return;
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  // Over the plan's active limit (e.g. after a downgrade): only the oldest enabled ones run
  if ((await countEnabledAutomations(profile.id)) > limits.maxActiveAutomations) {
    const allowed = (await listAutomations(profile.id))
      .filter((a) => a.enabled)
      .slice(0, limits.maxActiveAutomations)
      .map((a) => a.id);
    if (!allowed.includes(automation.id)) {
      await releaseAutomation(automation.id, { lastRunAt: now, lastError: `Your plan runs ${limits.maxActiveAutomations} automations at once; this one is paused.` });
      return;
    }
  }
  const periodStart = currentPeriodStart(now);
  let used = await countCountedRuns(profile.id, periodStart);
  let cursorAt = automation.cursorAt;
  // The cursor stays a little behind real time: an event stamped just before
  // a slow transaction commits is read on a later tick (keys prevent repeats)
  const settledBefore = new Date(now.getTime() - ENGINE.cursorLagMs);
  let lastError: string | null = null;

  // Retries first: failed runs whose backoff is over
  for (const failed of await retryableRuns(automation.id, now)) {
    const claimed = await claimRetry(failed.id, now);
    if (!claimed) continue;
    const [event] = await eventsFor(automation, now, [failed.entityId]);
    if (!event || event.key !== failed.eventKey) {
      await finishRun(claimed.id, { status: "skipped", reason: "event changed or gone", actionResults: [], aiCostUsd: null, durationMs: 0 });
      result.skipped++;
      continue;
    }
    result.retried++;
    const outcome = await execute(profile, automation, event, claimed);
    result[outcome]++;
  }

  const events = await eventsFor(automation, now);
  const known = await getRunsByKeys(
    automation.id,
    events.map((e) => e.key),
  );
  for (const event of events) {
    if (!known.has(event.key)) {
      const check = matchConditions(automation.conditions, event);
      if (!check.match) {
        await startRun({ automationId: automation.id, profileId: profile.id, eventKey: event.key, entityId: event.entityId, status: "skipped", reason: `conditions: ${check.reason}`, counted: false });
        result.skipped++;
      } else if (used >= limits.maxAutomationRunsPerMonth) {
        // Not counted, not retried: the month's allowance is used up
        await startRun({ automationId: automation.id, profileId: profile.id, eventKey: event.key, entityId: event.entityId, status: "skipped", reason: "monthly automation limit reached: not run, not counted", counted: false });
        lastError = `Monthly limit of ${limits.maxAutomationRunsPerMonth} runs reached.`;
        result.skipped++;
      } else {
        const run = await startRun({ automationId: automation.id, profileId: profile.id, eventKey: event.key, entityId: event.entityId, status: "running", reason: null, counted: true });
        // Another worker got it first: theirs
        if (run) {
          used++;
          const outcome = await execute(profile, automation, event, run);
          result[outcome]++;
          if (outcome === "failed") lastError = "An action failed; Scout retries it.";
        }
      }
    }
    // "New" triggers move their cursor past what's handled; due triggers use a window
    if (["new_opportunity", "high_intent_lead", "relevant_trend"].includes(automation.trigger) && event.at > cursorAt && event.at < settledBefore) {
      cursorAt = event.at;
    }
  }
  await releaseAutomation(automation.id, { cursorAt, lastRunAt: now, lastError });
}

/**
 * Scheduler step. Off with the kill switch; each automation claimed by one
 * worker; stops at the time budget. A database without the automation
 * tables (migration pending) is reported, not hidden.
 */
export async function runAutomations({ now = new Date(), timeBudgetMs = 60_000, maxAutomations = ENGINE.maxAutomations } = {}): Promise<AutomationTickResult> {
  const result: AutomationTickResult = { automations: 0, succeeded: 0, skipped: 0, failed: 0, retried: 0 };
  if (automationsPaused()) return { ...result, paused: true };
  const started = Date.now();
  let candidates: Automation[];
  try {
    candidates = await nextAutomations(now, maxAutomations);
  } catch (error) {
    if (isMissingSchemaError(error)) {
      console.error("Automation Scout is unavailable: the database is missing migration 'automation_scout'.");
      return result;
    }
    throw error;
  }
  for (const candidate of candidates) {
    if (Date.now() - started > timeBudgetMs) break;
    const automation = await claimAutomation(candidate.id, now, ENGINE.lockMinutes);
    if (!automation) continue;
    result.automations++;
    try {
      await processAutomation(automation, now, result);
    } catch (error) {
      console.error("Automation failed", automation.id, error);
      await releaseAutomation(automation.id, { lastRunAt: now, lastError: "Scout couldn't run this automation; it will try again." });
    }
  }
  return result;
}
