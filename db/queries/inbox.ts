import "server-only";

import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql, sum } from "drizzle-orm";

import db from "@/db";
import {
  type AiOperation,
  aiUsageTable,
  automationItemsTable,
  contentDraftsTable,
  growthExperimentsTable,
  inboxAutoBudgetsTable,
  type InboxDecisionRow,
  inboxDecisionsTable,
  type InboxPreparation,
  inboxPreparationsTable,
  type InboxRevision,
  inboxRevisionsTable,
  leadsTable,
  opportunitiesTable,
  profilesTable,
} from "@/db/schema";
import type { DeclineReason, InboxDecision, InboxItemType, RevisionKind } from "@/lib/inbox/types";

// Day 38 Approval Inbox. Every query is scoped by profileId; sources only
// read what Scout modules already stored (nothing here calls X or AI).

const HOUR = 3_600_000;

// ---- Sources ------------------------------------------------------------------------

/** Open opportunities found in the last `hours`, best first */
export async function freshOpportunities(profileId: string, now: Date, hours: number, limit = 15) {
  return db
    .select()
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.profileId, profileId),
        eq(opportunitiesTable.status, "new"),
        gte(sql`coalesce(${opportunitiesTable.postedAt}, ${opportunitiesTable.createdAt})`, new Date(now.getTime() - hours * HOUR)),
      ),
    )
    .orderBy(sql`${opportunitiesTable.score} desc nulls last`, desc(opportunitiesTable.createdAt))
    .limit(limit);
}

/** New high-intent leads not in the CRM yet */
export async function freshLeads(profileId: string, now: Date, hours: number, limit = 10) {
  return db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.profileId, profileId),
        eq(leadsTable.intent, "high"),
        eq(leadsTable.status, "new"),
        eq(leadsTable.saved, false),
        gte(leadsTable.createdAt, new Date(now.getTime() - hours * HOUR)),
      ),
    )
    .orderBy(desc(leadsTable.score), desc(leadsTable.createdAt))
    .limit(limit);
}

/** Single posts Scout prepared that nobody reviewed yet, newest first */
export async function preparedDrafts(profileId: string, now: Date, hours: number, limit = 5) {
  return db
    .select()
    .from(contentDraftsTable)
    .where(
      and(
        eq(contentDraftsTable.profileId, profileId),
        eq(contentDraftsTable.origin, "scout"),
        eq(contentDraftsTable.status, "draft"),
        eq(contentDraftsTable.format, "post"),
        isNull(contentDraftsTable.archivedAt),
        isNull(contentDraftsTable.publishedConfirmedAt),
        gte(contentDraftsTable.createdAt, new Date(now.getTime() - hours * HOUR)),
      ),
    )
    .orderBy(desc(contentDraftsTable.createdAt))
    .limit(limit);
}

/** Expiry: Scout-prepared drafts left unreviewed this long are archived (kept, hidden) */
export async function archiveStalePreparedDrafts(profileId: string, now: Date, hours: number): Promise<number> {
  const rows = await db
    .update(contentDraftsTable)
    .set({ archivedAt: now })
    .where(
      and(
        eq(contentDraftsTable.profileId, profileId),
        eq(contentDraftsTable.origin, "scout"),
        eq(contentDraftsTable.status, "draft"),
        isNull(contentDraftsTable.archivedAt),
        isNull(contentDraftsTable.publishedConfirmedAt),
        lt(contentDraftsTable.createdAt, new Date(now.getTime() - hours * HOUR)),
      ),
    )
    .returning({ id: contentDraftsTable.id });
  return rows.length;
}

/** Automation reminders and review items that are due, from the last `hours` */
export async function dueAutomationItems(profileId: string, now: Date, hours: number, limit = 20) {
  const from = new Date(now.getTime() - hours * HOUR);
  return db
    .select()
    .from(automationItemsTable)
    .where(
      and(
        eq(automationItemsTable.profileId, profileId),
        inArray(automationItemsTable.kind, ["reminder", "review"]),
        eq(automationItemsTable.status, "open"),
        or(
          and(lte(automationItemsTable.dueAt, now), gte(automationItemsTable.dueAt, from)),
          and(isNull(automationItemsTable.dueAt), gte(automationItemsTable.createdAt, from)),
        ),
      ),
    )
    .orderBy(sql`${automationItemsTable.dueAt} asc nulls last`, desc(automationItemsTable.createdAt))
    .limit(limit);
}

/** CRM follow-ups that are due (saved leads) */
export async function dueFollowUps(profileId: string, now: Date, hours: number, limit = 10) {
  return db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.profileId, profileId),
        eq(leadsTable.saved, true),
        isNull(leadsTable.followUpDoneAt),
        lte(leadsTable.followUpAt, now),
        gte(leadsTable.followUpAt, new Date(now.getTime() - hours * HOUR)),
      ),
    )
    .orderBy(asc(leadsTable.followUpAt))
    .limit(limit);
}

/** The newest experiment a strategy proposed */
export async function proposedExperiments(profileId: string, limit = 1) {
  return db
    .select()
    .from(growthExperimentsTable)
    .where(and(eq(growthExperimentsTable.profileId, profileId), eq(growthExperimentsTable.status, "proposed")))
    .orderBy(desc(growthExperimentsTable.createdAt))
    .limit(limit);
}

/** Closes the automation review items and reminders about an entity (the Inbox card handled it) */
export async function closeAutomationItemsFor(profileId: string, entityIds: string[], status: "reviewed" | "dismissed" | "done", now = new Date()): Promise<void> {
  if (entityIds.length === 0) return;
  await db
    .update(automationItemsTable)
    .set({ status, readAt: now })
    .where(
      and(
        eq(automationItemsTable.profileId, profileId),
        inArray(automationItemsTable.entityId, entityIds),
        inArray(automationItemsTable.kind, ["review", "reminder"]),
        eq(automationItemsTable.status, "open"),
      ),
    );
  // Their notifications are read too: the two never disagree
  await db
    .update(automationItemsTable)
    .set({ readAt: now })
    .where(
      and(
        eq(automationItemsTable.profileId, profileId),
        inArray(automationItemsTable.entityId, entityIds),
        eq(automationItemsTable.kind, "notification"),
        isNull(automationItemsTable.readAt),
      ),
    );
}

// ---- Decisions ----------------------------------------------------------------------

export async function getDecisions(profileId: string, keys: string[]): Promise<InboxDecisionRow[]> {
  if (keys.length === 0) return [];
  return db
    .select()
    .from(inboxDecisionsTable)
    .where(and(eq(inboxDecisionsTable.profileId, profileId), inArray(inboxDecisionsTable.itemKey, keys)));
}

export async function getDecision(profileId: string, key: string): Promise<InboxDecisionRow | undefined> {
  const [row] = await getDecisions(profileId, [key]);
  return row;
}

/**
 * Records a decision once. A key already decided (anything but a snooze)
 * returns null: the caller doesn't execute anything again. A snooze can be
 * replaced by a final decision or a later snooze.
 */
export async function claimDecision(values: {
  profileId: string;
  itemKey: string;
  itemType: InboxItemType;
  decision: InboxDecision;
  snoozedUntil?: Date | null;
  meta?: InboxDecisionRow["meta"];
}): Promise<InboxDecisionRow | null> {
  const [row] = await db
    .insert(inboxDecisionsTable)
    .values({ ...values, snoozedUntil: values.snoozedUntil ?? null, meta: values.meta ?? null })
    .onConflictDoUpdate({
      target: [inboxDecisionsTable.profileId, inboxDecisionsTable.itemKey],
      set: { decision: values.decision, snoozedUntil: values.snoozedUntil ?? null, meta: values.meta ?? null, updatedAt: new Date() },
      setWhere: sql`${inboxDecisionsTable.decision} = 'snoozed'`,
    })
    .returning();
  return row ?? null;
}

/** Undoes a claim whose action failed, so the user can try again */
export async function releaseDecision(profileId: string, id: string): Promise<void> {
  await db.delete(inboxDecisionsTable).where(and(eq(inboxDecisionsTable.profileId, profileId), eq(inboxDecisionsTable.id, id)));
}

/** The optional reason, on a decline that already happened */
export async function setDeclineReason(profileId: string, key: string, reason: DeclineReason): Promise<boolean> {
  const rows = await db
    .update(inboxDecisionsTable)
    .set({ reason })
    .where(
      and(
        eq(inboxDecisionsTable.profileId, profileId),
        eq(inboxDecisionsTable.itemKey, key),
        inArray(inboxDecisionsTable.decision, ["declined", "dismissed"]),
      ),
    )
    .returning({ id: inboxDecisionsTable.id });
  return rows.length > 0;
}

// ---- Revisions ----------------------------------------------------------------------

export async function insertRevision(values: { profileId: string; itemKey: string; kind: RevisionKind; instruction?: string | null; text: string; outcome?: InboxRevision["outcome"] }) {
  const [row] = await db
    .insert(inboxRevisionsTable)
    .values({ ...values, instruction: values.instruction ?? null, outcome: values.outcome ?? null })
    .returning();
  return row;
}

export async function getRevision(profileId: string, id: string): Promise<InboxRevision | undefined> {
  const [row] = await db
    .select()
    .from(inboxRevisionsTable)
    .where(and(eq(inboxRevisionsTable.profileId, profileId), eq(inboxRevisionsTable.id, id)))
    .limit(1);
  return row;
}

/** pending → accepted / rejected, once */
export async function resolveRevision(profileId: string, id: string, outcome: "accepted" | "rejected"): Promise<InboxRevision | null> {
  const [row] = await db
    .update(inboxRevisionsTable)
    .set({ outcome })
    .where(and(eq(inboxRevisionsTable.profileId, profileId), eq(inboxRevisionsTable.id, id), eq(inboxRevisionsTable.outcome, "pending")))
    .returning();
  return row ?? null;
}

export async function hasOriginal(profileId: string, itemKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: inboxRevisionsTable.id })
    .from(inboxRevisionsTable)
    .where(and(eq(inboxRevisionsTable.profileId, profileId), eq(inboxRevisionsTable.itemKey, itemKey), eq(inboxRevisionsTable.kind, "original")))
    .limit(1);
  return Boolean(row);
}

export async function getOriginal(profileId: string, itemKey: string): Promise<string | null> {
  const [row] = await db
    .select({ text: inboxRevisionsTable.text })
    .from(inboxRevisionsTable)
    .where(and(eq(inboxRevisionsTable.profileId, profileId), eq(inboxRevisionsTable.itemKey, itemKey), eq(inboxRevisionsTable.kind, "original")))
    .orderBy(asc(inboxRevisionsTable.createdAt))
    .limit(1);
  return row?.text ?? null;
}

/** AI revisions: of one item, since a moment, and the newest one's time */
export async function revisionStats(profileId: string, itemKey: string, since: Date) {
  const ai = inArray(inboxRevisionsTable.kind, ["ai_edit", "regenerate"]);
  const [[item], [today]] = await Promise.all([
    db.select({ n: count() }).from(inboxRevisionsTable).where(and(eq(inboxRevisionsTable.profileId, profileId), eq(inboxRevisionsTable.itemKey, itemKey), ai)),
    db
      .select({ n: count(), last: sql<Date | null>`max(${inboxRevisionsTable.createdAt})` })
      .from(inboxRevisionsTable)
      .where(and(eq(inboxRevisionsTable.profileId, profileId), ai, gte(inboxRevisionsTable.createdAt, since))),
  ]);
  return { forItem: item?.n ?? 0, today: today?.n ?? 0, lastAt: today?.last ? new Date(today.last) : null };
}

// ---- Learning signals ---------------------------------------------------------------

export async function learningSignals(profileId: string, since: Date | null, limit = 500) {
  const [decisions, revisions] = await Promise.all([
    db
      .select()
      .from(inboxDecisionsTable)
      .where(and(eq(inboxDecisionsTable.profileId, profileId), since ? gte(inboxDecisionsTable.createdAt, since) : undefined))
      .orderBy(desc(inboxDecisionsTable.createdAt))
      .limit(limit),
    db
      .select({ instruction: inboxRevisionsTable.instruction, outcome: inboxRevisionsTable.outcome })
      .from(inboxRevisionsTable)
      .where(
        and(
          eq(inboxRevisionsTable.profileId, profileId),
          eq(inboxRevisionsTable.kind, "ai_edit"),
          since ? gte(inboxRevisionsTable.createdAt, since) : undefined,
        ),
      )
      .orderBy(desc(inboxRevisionsTable.createdAt))
      .limit(limit),
  ]);
  return { decisions, revisions };
}

// ---- Preparation (paid, opt-in) -----------------------------------------------------

/**
 * Takes the next free slot of today's cap for this kind. The unique slot
 * makes the cap hold with concurrent workers: null when the cap is reached.
 */
export async function claimPreparationSlot(profileId: string, day: string, kind: "post" | "reply", cap: number): Promise<InboxPreparation | null> {
  for (let slot = 0; slot < cap; slot++) {
    const [row] = await db
      .insert(inboxPreparationsTable)
      .values({ profileId, day, kind, slot, status: "running" })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
  }
  return null;
}

export async function finishPreparation(id: string, patch: Pick<InboxPreparation, "status"> & Partial<Pick<InboxPreparation, "entityId" | "note" | "costUsd">>): Promise<void> {
  await db.update(inboxPreparationsTable).set(patch).where(eq(inboxPreparationsTable.id, id));
}

export async function preparationsOn(profileId: string, day: string) {
  return db
    .select()
    .from(inboxPreparationsTable)
    .where(and(eq(inboxPreparationsTable.profileId, profileId), eq(inboxPreparationsTable.day, day)));
}

/** Profiles that opted in and weren't prepared for in the last `spacingHours` */
export async function profilesToPrepare(now: Date, spacingHours: number, limit: number) {
  return db
    .select({ id: profilesTable.id })
    .from(profilesTable)
    .where(
      and(
        eq(profilesTable.autoPrepareEnabled, true),
        eq(profilesTable.onboardingCompleted, true),
        or(isNull(profilesTable.inboxPreparedAt), lt(profilesTable.inboxPreparedAt, new Date(now.getTime() - spacingHours * HOUR))),
      ),
    )
    .orderBy(sql`${profilesTable.inboxPreparedAt} asc nulls first`)
    .limit(limit);
}

/** One worker per profile: the conditional update is the lock */
export async function claimProfilePreparation(profileId: string, now: Date, spacingHours: number): Promise<boolean> {
  const rows = await db
    .update(profilesTable)
    .set({ inboxPreparedAt: now })
    .where(
      and(
        eq(profilesTable.id, profileId),
        eq(profilesTable.autoPrepareEnabled, true),
        or(isNull(profilesTable.inboxPreparedAt), lt(profilesTable.inboxPreparedAt, new Date(now.getTime() - spacingHours * HOUR))),
      ),
    )
    .returning({ id: profilesTable.id });
  return rows.length > 0;
}

export async function setAutoPrepare(profileId: string, enabled: boolean): Promise<void> {
  await db.update(profilesTable).set({ autoPrepareEnabled: enabled }).where(eq(profilesTable.id, profileId));
}

export async function resetInboxLearning(profileId: string, now = new Date()): Promise<void> {
  await db.update(profilesTable).set({ inboxLearningResetAt: now }).where(eq(profilesTable.id, profileId));
}

/** Drafts written since a moment, archived (declined) ones included: what not to repeat */
export async function recentDraftSources(profileId: string, since: Date) {
  return db
    .select({ topic: contentDraftsTable.topic, sourceTrendId: contentDraftsTable.sourceTrendId })
    .from(contentDraftsTable)
    .where(and(eq(contentDraftsTable.profileId, profileId), gte(contentDraftsTable.createdAt, since)))
    .limit(100);
}

/** AI spend on these operations since a moment (a preparation's own cost) */
export async function aiCostForOperationsSince(profileId: string, since: Date, operations: AiOperation[]): Promise<number> {
  const [row] = await db
    .select({ usd: sum(aiUsageTable.costUsd) })
    .from(aiUsageTable)
    .where(and(eq(aiUsageTable.profileId, profileId), gte(aiUsageTable.createdAt, since), inArray(aiUsageTable.operation, operations)));
  return Number(row?.usd ?? 0);
}

/** A preparation slot that didn't spend anything is given back (the next tick may use it) */
export async function releasePreparationSlot(id: string): Promise<void> {
  await db.delete(inboxPreparationsTable).where(eq(inboxPreparationsTable.id, id));
}

/**
 * Reserves `usd` of the month's automatic allowance, atomically: one
 * statement that only succeeds while the total stays within `capUsd`.
 * False: the reservation would pass the cap, so nothing may be spent.
 */
export async function reserveAutoSpend(profileId: string, month: string, usd: number, capUsd: number): Promise<boolean> {
  const t = inboxAutoBudgetsTable;
  const result = await db.execute(sql`
    insert into ${t} ("profileId", "month", "committedUsd")
    select ${profileId}::uuid, ${month}::date, ${usd}::float8
    where ${usd}::float8 <= ${capUsd}::float8
    on conflict ("profileId", "month") do update
      set "committedUsd" = ${t}."committedUsd" + excluded."committedUsd", "updatedAt" = now()
      where ${t}."committedUsd" + excluded."committedUsd" <= ${capUsd}::float8
    returning "id"
  `);
  return result.rows.length > 0;
}

/** Replaces a reservation with what the call actually cost (recorded usage) */
export async function settleAutoSpend(profileId: string, month: string, deltaUsd: number): Promise<void> {
  const t = inboxAutoBudgetsTable;
  await db
    .update(t)
    .set({ committedUsd: sql`greatest(0, ${t.committedUsd} + ${deltaUsd}::float8)` })
    .where(and(eq(t.profileId, profileId), eq(t.month, month)));
}

/** What automatic preparation committed this month, USD */
export async function autoSpend(profileId: string, month: string): Promise<number> {
  const t = inboxAutoBudgetsTable;
  const [row] = await db
    .select({ usd: t.committedUsd })
    .from(t)
    .where(and(eq(t.profileId, profileId), eq(t.month, month)))
    .limit(1);
  return row?.usd ?? 0;
}
