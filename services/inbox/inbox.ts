import "server-only";

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { setItemStatus, strategyTasksDue } from "@/db/queries/automations";
import { getDraft, getProfileTimeZone, getTrendsForContent, updateDraft } from "@/db/queries/content";
import {
  aiCostForOperationsSince,
  archiveStalePreparedDrafts,
  claimDecision,
  claimPreparationSlot,
  claimProfilePreparation,
  closeAutomationItemsFor,
  dueAutomationItems,
  dueFollowUps,
  finishPreparation,
  freshLeads,
  freshOpportunities,
  getDecision,
  getDecisions,
  getOriginal,
  getRevision,
  hasOriginal,
  insertRevision,
  learningSignals,
  preparedDrafts,
  profilesToPrepare,
  proposedExperiments,
  recentDraftSources,
  releaseDecision,
  releasePreparationSlot,
  reserveAutoSpend,
  resolveRevision,
  revisionStats,
  setDeclineReason,
  settleAutoSpend,
} from "@/db/queries/inbox";
import { getLead } from "@/db/queries/leads";
import { getOpportunityForProfile, setOpportunityStatus } from "@/db/queries/opportunities";
import { getProfileById } from "@/db/queries/profiles";
import { discardReplyDrafts, getCurrentReplies, saveReplyDrafts, setReplyApproved, updateReplyContent } from "@/db/queries/replies";
import { countActiveExperiments, getActiveStrategy, getExperiment, updateExperiment, updatePlanTask } from "@/db/queries/strategy";
import type { InboxDecisionRow, Profile } from "@/db/schema";
import { AutoBudgetRefused, type AutoCallLimits } from "@/lib/ai/ceiling";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import { effectiveLimits } from "@/lib/billing/plans";
import { isValidTimeZone, zonedParts } from "@/lib/content/calendar";
import { type ContentGoal, MAX_POST_CHARS, xIntentUrl } from "@/lib/content/types";
import { assembleInbox, greeting, type InboxSources, summarizeInbox } from "@/lib/inbox/assemble";
import { type InboxSignal, learnPreferences, preferenceGuidance } from "@/lib/inbox/learning";
import {
  DECLINE_REASONS,
  INBOX_MAX_AGE_HOURS,
  type InboxDecision,
  type InboxItemType,
  type InboxPreferences,
  MAX_REVISIONS_PER_ITEM,
  MIN_SECONDS_BETWEEN_REVISIONS,
  QUICK_EDITS,
  type QuickEdit,
} from "@/lib/inbox/types";
import { replyIntentUrl } from "@/lib/replies/xIntent";
import { experimentWindow } from "@/lib/strategy/plan";
import { MODULE_LINK, type StrategyModule } from "@/lib/strategy/types";
import { recordAiUsage } from "@/services/ai/usage";
import { track } from "@/services/analytics/track";
import { replyStyles } from "@/services/automations/engine";
import { BUDGET_MESSAGES, getUsageBudget } from "@/services/billing/budget";
import { createDraft, RULES, userContext } from "@/services/content/studio";
import { finishFollowUp, saveLeadToCrm } from "@/services/leads/crm";
import { generateReplies } from "@/services/replies/generateReply";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

// Day 38 Approval Inbox: Scout does the work, the user makes the decisions.
// Organizing stored data is free (no AI, no X). AI writing happens only on
// a click (Write reply, Regenerate, an AI edit, Write a post) or, opted in
// and switched on, in the bounded daily preparation. Nothing here calls X,
// and nothing is ever posted: an approved post or reply is copied and
// posted by the user in X's own composer.

const HOUR = 3_600_000;
/** Most experiments running at once (the same limit as Growth Strategy) */
const MAX_ACTIVE_EXPERIMENTS = 3;
/** A revision's conservative cost estimate, to keep inside the writing budget */
export const REVISION_USD = 0.01;

export type InboxResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

// ---- Keys ---------------------------------------------------------------------------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_PATTERNS = {
  draft: new RegExp(`^draft:(${UUID})$`, "i"),
  opportunity: new RegExp(`^opportunity:(${UUID})$`, "i"),
  lead: new RegExp(`^lead:(${UUID})$`, "i"),
  experiment: new RegExp(`^experiment:(${UUID})$`, "i"),
  item: new RegExp(`^item:(${UUID})$`, "i"),
  followup: new RegExp(`^followup:(${UUID}):(\\d{1,15})$`, "i"),
  task: new RegExp(`^task:(${UUID}):(\\d{4}-\\d{2}-\\d{2})$`, "i"),
};
type KeyKind = keyof typeof KEY_PATTERNS;

/** A card's key → what it points at. Unknown shapes are refused (never trusted input). */
export function parseKey(key: string): { kind: KeyKind; id: string; extra?: string } | null {
  if (typeof key !== "string" || key.length > 120) return null;
  for (const [kind, pattern] of Object.entries(KEY_PATTERNS) as [KeyKind, RegExp][]) {
    const match = pattern.exec(key);
    if (match) return { kind, id: match[1].toLowerCase(), extra: match[2] };
  }
  return null;
}

// ---- Loading ------------------------------------------------------------------------

async function localNow(profileId: string, now: Date) {
  const saved = await getProfileTimeZone(profileId);
  const tz = saved && isValidTimeZone(saved) ? saved : "UTC";
  return { tz, ...zonedParts(now, tz) };
}

export async function loadPreferences(profile: Pick<Profile, "id" | "inboxLearningResetAt">): Promise<InboxPreferences> {
  const { decisions, revisions } = await learningSignals(profile.id, profile.inboxLearningResetAt);
  const signals: InboxSignal[] = [
    ...decisions.map((d) => ({
      kind: "decision" as const,
      itemType: d.itemType,
      decision: d.decision,
      reason: d.reason,
      topic: d.meta?.topic ?? null,
      goal: d.meta?.goal ?? null,
      originalLength: d.meta?.originalLength ?? null,
      finalLength: d.meta?.finalLength ?? null,
    })),
    ...revisions.map((r) => ({ kind: "revision" as const, instruction: r.instruction, outcome: r.outcome })),
  ];
  return learnPreferences(signals);
}

function isHidden(decision: InboxDecisionRow, now: Date): boolean {
  return decision.decision !== "snoozed" || (decision.snoozedUntil !== null && decision.snoozedUntil > now);
}

/** Everything the Inbox shows, from stored data. No AI, no X. */
export async function loadInbox(profile: Profile, now = new Date()) {
  const local = await localNow(profile.id, now);
  const [opportunities, leads, drafts, autoItems, followUps, tasks, experiments, prefs] = await Promise.all([
    freshOpportunities(profile.id, now, INBOX_MAX_AGE_HOURS.conversation),
    freshLeads(profile.id, now, INBOX_MAX_AGE_HOURS.lead),
    preparedDrafts(profile.id, now, INBOX_MAX_AGE_HOURS.post),
    dueAutomationItems(profile.id, now, INBOX_MAX_AGE_HOURS.reminder),
    dueFollowUps(profile.id, now, INBOX_MAX_AGE_HOURS.followUp),
    strategyTasksDue(profile.id, local.date, local.date, 5),
    proposedExperiments(profile.id),
    loadPreferences(profile),
  ]);
  const replies = await getCurrentReplies(
    profile.id,
    opportunities.map((o) => o.id),
  );

  const sources: InboxSources = {
    conversations: opportunities.map((o) => {
      const reply = replies.get(o.id)?.find((r) => r.status !== "discarded");
      return { ...o, reply: reply ? { id: reply.id, content: reply.content } : null };
    }),
    leads,
    posts: drafts.map((d) => ({ id: d.id, text: d.posts[0] ?? "", why: d.idea?.why || "Based on what you talk about.", topic: d.topic, createdAt: d.createdAt })),
    reminders: [
      ...followUps
        .filter((l) => l.followUpAt)
        .map((l) => ({
          key: `followup:${l.id}:${l.followUpAt!.getTime()}`,
          entityId: l.id,
          title: `Follow up with @${l.authorHandle}`,
          body: l.followUpNote,
          href: `/crm/${l.id}`,
          at: l.followUpAt!,
        })),
      ...tasks.map(({ task }) => ({
        key: `task:${task.id}:${task.day}`,
        entityId: task.id,
        title: `${task.title} (~${task.effortMinutes} min)`,
        body: task.activity,
        href: MODULE_LINK[task.module as StrategyModule]?.href ?? "/strategy",
        at: new Date(`${task.day}T00:00:00Z`),
      })),
      ...autoItems.map((item) => ({ key: `item:${item.id}`, entityId: item.entityId, title: item.title, body: item.body, href: item.href, at: item.dueAt ?? item.createdAt })),
    ],
    recommendations: experiments.map((e) => ({
      key: `experiment:${e.id}`,
      title: e.title,
      text: `${e.title}: ${e.hypothesis}`,
      why: `A ${e.durationDays}-day experiment from your growth plan.`,
      at: e.createdAt,
    })),
  };

  const keys = [
    ...sources.conversations.map((c) => `opportunity:${c.id}`),
    ...sources.leads.flatMap((l) => [`lead:${l.id}`, ...(l.opportunityId ? [`opportunity:${l.opportunityId}`] : [])]),
    ...sources.posts.map((p) => `draft:${p.id}`),
    ...sources.reminders.map((r) => r.key),
    ...sources.recommendations.map((r) => r.key),
  ];
  const hidden = new Set(
    (await getDecisions(profile.id, keys)).filter((d) => isHidden(d, now)).map((d) => d.itemKey),
  );
  const items = assembleInbox(sources, hidden, prefs, now);
  return { items, summary: summarizeInbox(items), greeting: greeting(local.time), prefs };
}

// ---- Acting -------------------------------------------------------------------------

export const INBOX_ACTIONS = ["approve", "decline", "save", "dismiss", "accept", "done", "snooze", "write_reply"] as const;
export type InboxAction = (typeof INBOX_ACTIONS)[number];

export type ActOutcome = {
  /** What happened, in plain words (never "Published") */
  outcome: string;
  /** Already decided before: nothing ran again */
  already?: boolean;
  /** Approved post / reply: what to copy, and X's own composer to post it */
  copyText?: string;
  openUrl?: string | null;
  /** Approved reply: recorded as opened on X / copied when the user does it (never as posted) */
  opportunityId?: string;
  replyId?: string;
};

/** Which actions each card offers: anything else is refused */
const ALLOWED: Record<KeyKind, InboxAction[]> = {
  draft: ["approve", "decline"],
  opportunity: ["approve", "decline", "save", "dismiss", "write_reply"],
  lead: ["save", "dismiss"],
  experiment: ["accept", "dismiss"],
  item: ["done", "snooze"],
  followup: ["done", "snooze"],
  task: ["done", "snooze"],
};

const ALREADY: ActOutcome = { outcome: "Already done.", already: true };

/**
 * Runs `effect` only if this request recorded the decision: a second click,
 * a retry or another tab finds the decision taken and runs nothing. If the
 * effect fails, the decision is released so the user can try again.
 */
async function decideOnce(
  profile: Profile,
  key: string,
  itemType: InboxItemType,
  decision: InboxDecision,
  effect: () => Promise<ActOutcome | { error: string }>,
  extra: { meta?: InboxDecisionRow["meta"]; snoozedUntil?: Date } = {},
): Promise<InboxResult<ActOutcome>> {
  const claimed = await claimDecision({ profileId: profile.id, itemKey: key, itemType, decision, ...extra });
  if (!claimed) return { ok: true, ...ALREADY };
  try {
    const result = await effect();
    if ("error" in result) {
      await releaseDecision(profile.id, claimed.id);
      return { ok: false, message: result.error };
    }
    await track("inbox_action", { profileId: profile.id, props: { type: itemType, action: decision } });
    return { ok: true, ...result };
  } catch (error) {
    await releaseDecision(profile.id, claimed.id);
    throw error;
  }
}

async function currentReply(profileId: string, opportunityId: string) {
  return (await getCurrentReplies(profileId, [opportunityId])).get(opportunityId)?.find((r) => r.status !== "discarded");
}

export async function actOnItem(profile: Profile, key: string, action: InboxAction, now = new Date()): Promise<InboxResult<ActOutcome>> {
  const parsed = parseKey(key);
  if (!parsed || !ALLOWED[parsed.kind].includes(action)) return { ok: false, message: "That action isn't available here." };
  const { kind, id } = parsed;

  if (action === "snooze") {
    const until = new Date(now.getTime() + 24 * HOUR);
    return decideOnce(profile, key, "reminder", "snoozed", async () => ({ outcome: "Snoozed until tomorrow." }), { snoozedUntil: until });
  }

  if (kind === "draft") {
    const draft = await getDraft(profile.id, id);
    if (!draft) return { ok: false, message: "This draft is gone." };
    const text = draft.posts[0] ?? "";
    if (action === "approve") {
      const original = (await getOriginal(profile.id, key)) ?? text;
      return decideOnce(
        profile,
        key,
        "post",
        "approved",
        async () => {
          await updateDraft(profile.id, id, { status: "ready", archivedAt: null });
          return { outcome: "Approved. It's in Content, ready for you to post.", copyText: text, openUrl: xIntentUrl(text) };
        },
        { meta: { topic: draft.topic, goal: draft.goal, originalLength: original.length, finalLength: text.length, edited: original !== text } },
      );
    }
    return decideOnce(
      profile,
      key,
      "post",
      "declined",
      async () => {
        await updateDraft(profile.id, id, { archivedAt: now });
        return { outcome: "Declined." };
      },
      { meta: { topic: draft.topic, goal: draft.goal } },
    );
  }

  if (kind === "opportunity") {
    const opportunity = await getOpportunityForProfile(profile.id, id);
    if (!opportunity) return { ok: false, message: "This conversation is gone." };
    const meta = { topic: opportunity.topic };
    if (action === "write_reply") return writeReply(profile, id);
    if (action === "approve") {
      const reply = await currentReply(profile.id, id);
      if (!reply) return { ok: false, message: "There's no reply to approve yet." };
      return decideOnce(
        profile,
        key,
        "reply",
        "approved",
        async () => {
          await setReplyApproved(profile.id, reply.id);
          // Handled, not sent: it leaves "new" in Opportunities (a reply opened or confirmed on X is never downgraded)
          if (opportunity.status === "new") await setOpportunityStatus(profile.id, id, "saved");
          await closeAutomationItemsFor(profile.id, [id], "reviewed", now);
          return {
            outcome: "Approved. Copy it and post it on X yourself.",
            opportunityId: id,
            replyId: reply.id,
            copyText: reply.content,
            openUrl: replyIntentUrl(opportunity.platformPostId, reply.content) ?? opportunity.postUrl,
          };
        },
        { meta: { ...meta, originalLength: reply.originalContent.length, finalLength: reply.content.length, edited: reply.originalContent !== reply.content } },
      );
    }
    const hasReply = Boolean(await currentReply(profile.id, id));
    const decision: InboxDecision = action === "save" ? "saved" : action === "decline" ? "declined" : "dismissed";
    return decideOnce(
      profile,
      key,
      hasReply ? "reply" : "conversation",
      decision,
      async () => {
        if (action === "save") {
          await setOpportunityStatus(profile.id, id, "saved");
          await closeAutomationItemsFor(profile.id, [id], "reviewed", now);
          return { outcome: "Saved to Opportunities." };
        }
        await discardReplyDrafts(profile.id, id);
        await setOpportunityStatus(profile.id, id, "dismissed");
        await closeAutomationItemsFor(profile.id, [id], "dismissed", now);
        return { outcome: action === "decline" ? "Declined." : "Dismissed." };
      },
      { meta },
    );
  }

  if (kind === "lead") {
    const lead = await getLead(profile.id, id);
    if (!lead) return { ok: false, message: "This lead is gone." };
    if (action === "save") {
      return decideOnce(profile, key, "lead", "saved", async () => {
        const saved = await saveLeadToCrm(profile, id, true);
        if (!saved.ok) return { error: saved.message };
        await closeAutomationItemsFor(profile.id, [id], "reviewed", now);
        return { outcome: "Saved to your CRM." };
      });
    }
    return decideOnce(profile, key, "lead", "dismissed", async () => {
      await closeAutomationItemsFor(profile.id, [id], "dismissed", now);
      return { outcome: "Dismissed." };
    });
  }

  if (kind === "experiment") {
    const experiment = await getExperiment(profile.id, id);
    if (!experiment) return { ok: false, message: "This suggestion is gone." };
    if (action === "accept") {
      return decideOnce(profile, key, "recommendation", "accepted", async () => {
        if (experiment.status !== "proposed") return { outcome: "Already started." };
        if ((await countActiveExperiments(profile.id)) >= MAX_ACTIVE_EXPERIMENTS) {
          return { error: `You're already running ${MAX_ACTIVE_EXPERIMENTS} experiments. Finish one in Growth Strategy first.` };
        }
        await updateExperiment(profile.id, id, { status: "active", ...experimentWindow(experiment.durationDays) });
        return { outcome: "Started. Track it in Growth Strategy." };
      });
    }
    return decideOnce(profile, key, "recommendation", "dismissed", async () => {
      if (experiment.status === "proposed") await updateExperiment(profile.id, id, { status: "stopped", conclusion: null, endsAt: now });
      return { outcome: "Dismissed." };
    });
  }

  // Reminders: done
  return decideOnce(profile, key, "reminder", "done", async () => {
    if (kind === "item") {
      await setItemStatus(profile.id, id, "done", now);
    } else if (kind === "followup") {
      const done = await finishFollowUp(profile, id);
      if (!done.ok && done.message !== "No follow-up to complete.") return { error: done.message };
      await closeAutomationItemsFor(profile.id, [id], "done", now);
    } else {
      await updatePlanTask(profile.id, id, { status: "done" }, now);
      await closeAutomationItemsFor(profile.id, [id], "done", now);
    }
    return { outcome: "Done." };
  });
}

/** The optional "why wasn't this useful?" after a decline. No AI call. */
export async function recordDeclineReason(profile: Profile, key: string, reason: string): Promise<InboxResult> {
  const parsed = z.enum(DECLINE_REASONS).safeParse(reason);
  if (!parseKey(key) || !parsed.success) return { ok: false, message: "Invalid request." };
  return (await setDeclineReason(profile.id, key, parsed.data)) ? { ok: true } : { ok: false, message: "Decline it first." };
}

/** "Write reply" on a conversation: two drafts from the writing budget (the existing reply engine) */
async function writeReply(profile: Profile, opportunityId: string, auto?: AutoCallLimits): Promise<InboxResult<ActOutcome>> {
  if (await currentReply(profile.id, opportunityId)) return { ok: true, outcome: "Reply ready.", already: true };
  const result = await generateReplies(profile.id, opportunityId, { styles: await replyStyles(profile.id), auto });
  if (result.status === "budget_exhausted") return { ok: false, message: BUDGET_MESSAGES.replies };
  if (result.status === "no_brain") return { ok: false, message: "Scout needs your Scout Brain first (Settings)." };
  if (result.status === "not_found") return { ok: false, message: "This conversation is gone." };
  await track("inbox_action", { profileId: profile.id, props: { type: "conversation", action: "write_reply" } });
  return { ok: true, outcome: "Reply ready." };
}

// ---- Editing ------------------------------------------------------------------------

const textSchema = z.string().trim().min(1, "It can't be empty.").max(MAX_POST_CHARS, "That's too long to save.");

/** The draft or reply behind a card, owned by the profile */
async function editable(profile: Profile, key: string) {
  const parsed = parseKey(key);
  if (parsed?.kind === "draft") {
    const draft = await getDraft(profile.id, parsed.id);
    if (!draft || draft.format !== "post") return null;
    return { kind: "draft" as const, id: parsed.id, text: draft.posts[0] ?? "", draft };
  }
  if (parsed?.kind === "opportunity") {
    const opportunity = await getOpportunityForProfile(profile.id, parsed.id);
    const reply = opportunity ? await currentReply(profile.id, parsed.id) : undefined;
    if (!opportunity || !reply) return null;
    return { kind: "reply" as const, id: parsed.id, text: reply.content, reply, opportunity };
  }
  return null;
}

/** The first version is kept before anything changes it */
async function keepOriginal(profile: Profile, key: string, text: string) {
  if (!(await hasOriginal(profile.id, key))) await insertRevision({ profileId: profile.id, itemKey: key, kind: "original", text });
}

/** Autosave of a manual edit. The original stays in the version history. */
export async function saveText(profile: Profile, key: string, raw: string): Promise<InboxResult> {
  const text = textSchema.safeParse(raw);
  if (!text.success) return { ok: false, message: text.error.issues[0]?.message ?? "Check the text." };
  const target = await editable(profile, key);
  if (!target) return { ok: false, message: "This draft is gone." };
  if (target.text === text.data) return { ok: true };
  await keepOriginal(profile, key, target.text);
  if (target.kind === "draft") await updateDraft(profile.id, target.id, { posts: [text.data] });
  else await updateReplyContent(profile.id, target.reply.id, text.data);
  return { ok: true };
}

const QUICK_GUIDE: Record<QuickEdit, string> = {
  shorter: "Make it noticeably shorter. Keep the point and the details that matter.",
  natural: "Make it sound more natural, the way they'd actually say it. Same point.",
  hook: "Give it a stronger first line that makes the right people stop and read. Same point, no clickbait.",
  less_promo: "Make it less promotional: lead with what's useful, drop pitching and salesy words.",
};
const REGENERATE_GUIDE = "Write a different version: the same purpose and context, a different way in. Not a paraphrase of the current text.";

const REVISE_RULES = `${RULES}
You edit the CURRENT text given, never write about something else. Preserve its facts, numbers, links (URLs) and @mentions exactly unless the user explicitly asked to change them. Never add results, experiences, numbers, quotes or claims that aren't in the current text or their profile. Use a [placeholder] for anything only the user knows.`;

const REPLY_RULES = "It's a reply on X to the post given: talk to its author about their post. No hashtags, links or self-promotion unless the current text already has them.";

const revisionSchema = z.object({ text: z.string() });

export type ReviseRequest = { type: "quick"; edit: string } | { type: "custom"; instruction: string } | { type: "regenerate" };

const URL_OR_MENTION = /https?:\/\/\S+|@\w{1,15}/gi;

/** Links and @mentions the AI dropped: shown as a warning on the preview */
export function droppedReferences(before: string, after: string): string[] {
  const kept = new Set((after.match(URL_OR_MENTION) ?? []).map((m) => m.toLowerCase()));
  return [...new Set((before.match(URL_OR_MENTION) ?? []).filter((m) => !kept.has(m.toLowerCase())))];
}

/**
 * One AI edit or regeneration of the text on screen, saved as a preview:
 * nothing changes until the user picks "Use this". Writing budget, per-item
 * cap, daily cap and pacing are checked before the call.
 */
export async function reviseText(
  profile: Profile,
  key: string,
  request: ReviseRequest,
  rawCurrent: string,
  now = new Date(),
): Promise<InboxResult<{ revisionId: string; text: string; warning: string | null }>> {
  const current = textSchema.safeParse(rawCurrent);
  if (!current.success) return { ok: false, message: current.error.issues[0]?.message ?? "Check the text." };
  let instruction: string;
  let guide: string;
  if (request.type === "quick") {
    const edit = z.enum(QUICK_EDITS).safeParse(request.edit);
    if (!edit.success) return { ok: false, message: "Unknown edit." };
    instruction = edit.data;
    guide = QUICK_GUIDE[edit.data];
  } else if (request.type === "custom") {
    const text = z.string().trim().min(2, "Tell Scout what to change.").max(300, "Keep it under 300 characters.").safeParse(request.instruction);
    if (!text.success) return { ok: false, message: text.error.issues[0]?.message ?? "Check the instruction." };
    instruction = text.data;
    guide = `The user asked: "${text.data}". Change what they asked for and keep everything else.`;
  } else {
    instruction = "regenerate";
    guide = REGENERATE_GUIDE;
  }

  const target = await editable(profile, key);
  if (!target) return { ok: false, message: "This draft is gone." };
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  const stats = await revisionStats(profile.id, key, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  if (stats.forItem >= MAX_REVISIONS_PER_ITEM) return { ok: false, message: "That's enough versions of this one. Edit it yourself, or decline it." };
  if (stats.today >= limits.maxInboxRevisionsPerDay) return { ok: false, message: "You've used today's AI edits. Edit it yourself, or try again tomorrow." };
  if (stats.lastAt && now.getTime() - stats.lastAt.getTime() < MIN_SECONDS_BETWEEN_REVISIONS * 1000) return { ok: false, message: "One at a time. Try again in a few seconds." };
  if ((await getUsageBudget(profile, now)).remaining.replyUsd < REVISION_USD) return { ok: false, message: BUDGET_MESSAGES.replies };

  const prefs = await loadPreferences(profile);
  const learned = preferenceGuidance(prefs);
  const response = await getOpenAI().responses.parse({
    model: AI_MODELS.reply,
    instructions: `${REVISE_RULES}${target.kind === "reply" ? `\n${REPLY_RULES}` : ""}
${guide}
Return only the new text.${learned.length ? `\nLearned from this user's own choices:\n${learned.map((line) => `- ${line}`).join("\n")}` : ""}`,
    input: JSON.stringify({
      user: userContext(profile),
      kind: target.kind === "reply" ? "reply" : "post",
      replyingTo: target.kind === "reply" ? { author: target.opportunity.authorHandle, text: target.opportunity.content } : null,
      goal: target.kind === "draft" ? target.draft.goal : null,
      current: current.data,
    }),
    max_output_tokens: 1200,
    text: { format: zodTextFormat(revisionSchema, "inbox_revision") },
  });
  await recordAiUsage(
    target.kind === "reply"
      ? { profileId: profile.id, operation: "reply_generation", scoutRunId: target.opportunity.scoutRunId }
      : { profileId: profile.id, operation: "content_generation" },
    response,
  );
  const text = revisionSchema.safeParse(response.output_parsed).data?.text.trim().slice(0, MAX_POST_CHARS);
  if (!text) return { ok: false, message: "Couldn't write a new version this time. Try again." };
  await keepOriginal(profile, key, target.text);
  const revision = await insertRevision({
    profileId: profile.id,
    itemKey: key,
    kind: request.type === "regenerate" ? "regenerate" : "ai_edit",
    instruction,
    text,
    outcome: "pending",
  });
  await track("inbox_revision", { profileId: profile.id, props: { type: target.kind, edit: request.type === "quick" ? instruction : request.type } });
  const dropped = droppedReferences(current.data, text);
  return { ok: true, revisionId: revision.id, text, warning: dropped.length ? `This version leaves out ${dropped.join(", ")}.` : null };
}

/** "Use this" / "Keep original" on an AI preview; once per preview */
export async function decideRevision(profile: Profile, revisionId: string, accept: boolean): Promise<InboxResult<{ text: string | null; already?: boolean }>> {
  if (!z.uuid().safeParse(revisionId).success) return { ok: false, message: "Invalid request." };
  const pending = await getRevision(profile.id, revisionId);
  if (!pending) return { ok: false, message: "This version is gone." };
  const target = await editable(profile, pending.itemKey);
  if (!target) return { ok: false, message: "This draft is gone." };
  const resolved = await resolveRevision(profile.id, revisionId, accept ? "accepted" : "rejected");
  if (!resolved) return { ok: true, text: null, already: true };
  if (accept) {
    if (target.kind === "draft") await updateDraft(profile.id, target.id, { posts: [resolved.text] });
    else if (resolved.kind === "regenerate") {
      // A new AI draft (the previous one is kept as discarded), so reply learning reads it as Scout's, not the user's
      await saveReplyDrafts(target.id, [{ style: target.reply.variant, text: resolved.text }], null);
    } else await updateReplyContent(profile.id, target.reply.id, resolved.text);
  }
  return { ok: true, text: accept ? resolved.text : null };
}

// ---- Preparation --------------------------------------------------------------------

/** Automatic preparation runs only with this switched on (and the user opted in) */
export function autoPrepareAvailable(): boolean {
  return process.env.INBOX_AUTO_PREPARE_ENABLED === "true";
}

const OBJECTIVE_GOAL: Record<string, ContentGoal> = {
  find_customers: "generate_leads",
  generate_leads: "generate_leads",
  build_authority: "build_authority",
  grow_audience: "grow_audience",
  meaningful_engagement: "start_conversations",
};

function dayOfYear(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000);
}

/** Unreviewed Scout drafts (a decided one doesn't count) */
async function waitingDraftIds(profileId: string, now: Date): Promise<string[]> {
  const drafts = await preparedDrafts(profileId, now, INBOX_MAX_AGE_HOURS.post);
  const decided = new Set((await getDecisions(profileId, drafts.map((d) => `draft:${d.id}`))).filter((d) => d.decision !== "snoozed").map((d) => d.itemKey));
  return drafts.filter((d) => !decided.has(`draft:${d.id}`)).map((d) => d.id);
}

/** What automatic preparation counts as good enough; below it, Scout prepares less, not filler */
export const AUTO_QUALITY = {
  /** Replies: only for conversations this strong and this fresh */
  replyMinScore: 75,
  replyMaxAgeHours: 24,
  /** Posts: only from a growth-plan task, a saved trend, or a trend at least this relevant */
  trendMinRelevance: 60,
} as const;

/** Output caps for automatic calls: they bound each call's worst-case cost */
export const AUTO_OUTPUT_TOKENS = { post: 600, reply: 1200 } as const;

/**
 * Prepares one post for review, from the writing budget (Content Studio's
 * generator): today's growth-plan writing task, else a saved or strongly
 * relevant trend no post used yet; on request also a Scout Brain topic in
 * rotation. Never when a prepared post is still waiting: no duplicate
 * drafts, no pile-up. Automatic runs (`auto`) take no Brain-topic filler and
 * go through the budget gate.
 */
export async function preparePost(
  profile: Profile,
  now = new Date(),
  auto?: AutoCallLimits,
): Promise<InboxResult<{ draftId: string; already?: boolean }>> {
  await archiveStalePreparedDrafts(profile.id, now, INBOX_MAX_AGE_HOURS.post);
  const [waiting] = await waitingDraftIds(profile.id, now);
  if (waiting) return { ok: true, draftId: waiting, already: true };

  const local = await localNow(profile.id, now);
  const [prefs, tasks, trends, recentDrafts, strategy] = await Promise.all([
    loadPreferences(profile),
    strategyTasksDue(profile.id, local.date, local.date, 5),
    getTrendsForContent(profile.id, 6),
    recentDraftSources(profile.id, new Date(now.getTime() - 14 * 24 * HOUR)),
    getActiveStrategy(profile.id),
  ]);
  const usedTrends = new Set(recentDrafts.map((d) => d.sourceTrendId).filter(Boolean));
  const usedTopics = new Set(recentDrafts.map((d) => d.topic?.toLowerCase()).filter(Boolean));
  const avoid = new Set(prefs.avoidTopics);

  let topic: string | undefined;
  let trendId: string | undefined;
  let why: string;
  const task = tasks.find(({ task: t }) => t.module === "studio" && !usedTopics.has(t.activity.toLowerCase()))?.task;
  const trend = trends.find(
    (t) => !usedTrends.has(t.id) && !avoid.has(t.label.toLowerCase()) && (!auto || t.saved || t.relevance >= AUTO_QUALITY.trendMinRelevance),
  );
  if (task) {
    topic = task.activity.slice(0, 300);
    why = "Based on your growth plan for today.";
  } else if (trend) {
    trendId = trend.id;
    topic = trend.label.slice(0, 300);
    why = "Based on a trend in your niche.";
  } else if (auto) {
    return { ok: false, message: "nothing good enough to write about" };
  } else {
    const brainTopics = (resolveScoutBrain(profile)?.interests.topics.map((t) => t.label) ?? profile.topics?.split(",") ?? [])
      .map((t) => t.trim())
      .filter((t) => t && !avoid.has(t.toLowerCase()));
    const fresh = brainTopics.filter((t) => !usedTopics.has(t.toLowerCase()));
    const pool = fresh.length ? fresh : brainTopics;
    if (pool.length === 0) return { ok: false, message: "Tell Scout what you talk about first (Settings, Scout Brain)." };
    topic = pool[dayOfYear(local.date) % pool.length];
    why = "Based on what you talk about.";
  }

  let goal: ContentGoal = (prefs.favoredGoal as ContentGoal | null) ?? OBJECTIVE_GOAL[strategy?.objective ?? ""] ?? "build_authority";
  if (prefs.lessPromotional && goal === "promote_product") goal = "build_authority";
  const result = await createDraft(
    profile,
    {
      goal,
      format: "post",
      tone: "conversational",
      length: prefs.shorter ? "short" : "medium",
      topic,
      trendId,
      idea: { hook: topic.slice(0, 280), description: "", format: "post", audience: "", why },
    },
    { origin: "scout", guidance: preferenceGuidance(prefs), auto },
  );
  if (!result.ok) return result;
  const draft = await getDraft(profile.id, result.draftId);
  if (draft) await keepOriginal(profile, `draft:${draft.id}`, draft.posts[0] ?? "");
  await track("inbox_prepared", { profileId: profile.id, props: { kind: "post", auto: Boolean(auto) } });
  return { ok: true, draftId: result.draftId };
}

export type PreparationResult = { posts: number; replies: number; skipped: string[] };

/** The first day of the plan's counting window (UTC): the day, its week's Monday, or the 1st */
export function windowStart(window: "day" | "week" | "month", now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const start =
    window === "day" ? new Date(Date.UTC(y, m, d)) : window === "week" ? new Date(Date.UTC(y, m, d - ((now.getUTCDay() + 6) % 7))) : new Date(Date.UTC(y, m, 1));
  return start.toISOString().slice(0, 10);
}

type StepOutcome = { status: "done" | "skipped"; entityId?: string | null; note?: string | null };
export type StepResult = "done" | "cap" | "refused" | "skipped" | "failed";

/**
 * One automatic generation under both limits. The item limit: a unique slot
 * in the plan's window. The money limit: the call's worst-case cost is
 * reserved in one conditional statement (never past the monthly cap, never
 * into the writing budget kept for the user) before the call, then settled
 * to the cost actually recorded. A slot that spent nothing is given back.
 */
async function autoStep(profile: Profile, kind: "post" | "reply", now: Date, run: (auto: AutoCallLimits) => Promise<StepOutcome>): Promise<StepResult> {
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  const max = kind === "post" ? limits.maxAutoPosts : limits.maxAutoReplySets;
  const slot = await claimPreparationSlot(profile.id, windowStart(limits.autoPrepareWindow, now), kind, max);
  if (!slot) return "cap";

  const month = windowStart("month", now);
  let reserved = 0;
  const gate = async (ceilingUsd: number | null) => {
    if (ceilingUsd === null) throw new AutoBudgetRefused("model has no price: its cost can't be bounded");
    const budget = await getUsageBudget(profile, now);
    if (budget.monthRemaining.replyUsd - ceilingUsd < limits.reservedManualWritingUsd) throw new AutoBudgetRefused("writing budget kept for you");
    if (!(await reserveAutoSpend(profile.id, month, ceilingUsd, limits.maxAutoPrepareUsdPerMonth))) throw new AutoBudgetRefused("monthly automatic limit");
    reserved = ceilingUsd;
  };

  const since = new Date(Date.now() - 1000);
  let outcome: StepOutcome | null = null;
  let refusal: string | null = null;
  let failure: string | null = null;
  try {
    outcome = await run({ maxOutputTokens: AUTO_OUTPUT_TOKENS[kind], gate });
  } catch (error) {
    if (error instanceof AutoBudgetRefused) refusal = error.message;
    else failure = error instanceof Error ? error.message.slice(0, 160) : "error";
  }
  const actual = reserved > 0 ? await aiCostForOperationsSince(profile.id, since, [kind === "post" ? "content_generation" : "reply_generation"]) : 0;
  if (reserved > 0) await settleAutoSpend(profile.id, month, actual - reserved);

  if (actual === 0 && (refusal || failure || outcome?.status !== "done")) {
    await releasePreparationSlot(slot.id);
    return refusal ? "refused" : failure ? "failed" : "skipped";
  }
  const status = failure ? "failed" : (outcome?.status ?? "failed");
  await finishPreparation(slot.id, { status, entityId: outcome?.entityId ?? null, note: failure ?? outcome?.note ?? null, costUsd: actual });
  return status;
}

/**
 * Automatic preparation for one profile (scheduler; opt-in, switched on).
 * Replies first, for the strongest fresh conversations only; then a post,
 * only from a real basis and only when none is waiting. Fewer items when
 * nothing is good enough: no filler.
 */
export async function prepareInbox(profile: Profile, now = new Date()): Promise<PreparationResult> {
  const result: PreparationResult = { posts: 0, replies: 0, skipped: [] };
  await archiveStalePreparedDrafts(profile.id, now, INBOX_MAX_AGE_HOURS.post);
  if (!autoPrepareAvailable() || !profile.autoPrepareEnabled) {
    result.skipped.push("off");
    return result;
  }
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);

  if (limits.maxAutoReplySets > 0) {
    const { items } = await loadInbox(profile, now);
    const strong = items.filter(
      (i) => i.type === "conversation" && i.score >= AUTO_QUALITY.replyMinScore && now.getTime() - Date.parse(i.at) <= AUTO_QUALITY.replyMaxAgeHours * HOUR,
    );
    if (strong.length === 0) result.skipped.push("no strong conversation");
    for (const item of strong) {
      const opportunityId = parseKey(item.key)!.id;
      const step = await autoStep(profile, "reply", now, async (auto) => {
        const reply = await writeReply(profile, opportunityId, auto);
        return reply.ok && !reply.already
          ? { status: "done", entityId: opportunityId }
          : { status: "skipped", entityId: opportunityId, note: reply.ok ? "already drafted" : reply.message.slice(0, 160) };
      });
      if (step === "done") result.replies++;
      else if (step !== "skipped") {
        result.skipped.push(`reply ${step}`);
        if (step === "cap" || step === "refused") break;
      }
    }
  }

  if ((await waitingDraftIds(profile.id, now)).length > 0) result.skipped.push("post waiting");
  else if (limits.maxAutoPosts > 0) {
    const step = await autoStep(profile, "post", now, async (auto) => {
      const post = await preparePost(profile, now, auto);
      return post.ok && !post.already ? { status: "done", entityId: post.draftId } : { status: "skipped", note: post.ok ? "already waiting" : post.message.slice(0, 160) };
    });
    if (step === "done") result.posts++;
    else result.skipped.push(`post ${step}`);
  }
  return result;
}

export const PREPARATION = {
  /** Profiles per scheduler tick */
  maxProfiles: 10,
  /**
   * A profile is looked at again after this: the 5-minute cron doesn't
   * re-run it every tick (and the caps hold even if it did)
   */
  spacingHours: 6,
};

/** Scheduler step: off unless INBOX_AUTO_PREPARE_ENABLED=true; one worker per profile */
export async function runInboxPreparation({ now = new Date(), timeBudgetMs = 60_000, maxProfiles = PREPARATION.maxProfiles } = {}) {
  if (!autoPrepareAvailable()) return { disabled: true as const, profiles: 0, posts: 0, replies: 0 };
  const started = Date.now();
  const totals = { profiles: 0, posts: 0, replies: 0 };
  for (const { id } of await profilesToPrepare(now, PREPARATION.spacingHours, maxProfiles)) {
    if (Date.now() - started > timeBudgetMs) break;
    if (!(await claimProfilePreparation(id, now, PREPARATION.spacingHours))) continue;
    const profile = await getProfileById(id);
    if (!profile) continue;
    totals.profiles++;
    try {
      const prepared = await prepareInbox(profile, now);
      totals.posts += prepared.posts;
      totals.replies += prepared.replies;
    } catch (error) {
      console.error("Inbox preparation failed", id, error instanceof Error ? error.message : error);
    }
  }
  return totals;
}

/** For tests and the settings card */
export async function getItemDecision(profile: Profile, key: string) {
  return getDecision(profile.id, key);
}
