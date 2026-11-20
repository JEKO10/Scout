import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql, sum } from "drizzle-orm";

import db from "@/db";
import { contentDraftsTable, inboxDecisionsTable, type XPublication, xPublicationsTable, xPublishBudgetsTable } from "@/db/schema";
import type { PublicationStatus } from "@/lib/x/publishing";

// Day 40 X publishing. Every user-facing query is scoped by profileId. State
// changes are conditional updates, so two workers (or two clicks) can never
// both move the same publication forward.

const t = xPublicationsTable;
const ACTIVE: PublicationStatus[] = ["approved", "scheduled", "publishing", "unknown"];

export async function getPublication(profileId: string, id: string): Promise<XPublication | undefined> {
  const [row] = await db.select().from(t).where(and(eq(t.profileId, profileId), eq(t.id, id))).limit(1);
  return row;
}

/** The draft's live publication (approved, scheduled, publishing or unknown) */
export async function getActivePublicationForDraft(profileId: string, draftId: string): Promise<XPublication | undefined> {
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.profileId, profileId), eq(t.draftId, draftId), inArray(t.status, ACTIVE)))
    .limit(1);
  return row;
}

/** The newest publication of each draft (any state but cancelled): what Calendar and Studio show */
export async function latestPublicationsForDrafts(profileId: string, draftIds: string[]): Promise<Map<string, XPublication>> {
  if (draftIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.profileId, profileId), inArray(t.draftId, draftIds), sql`${t.status} <> 'cancelled'`))
    .orderBy(desc(t.createdAt));
  const map = new Map<string, XPublication>();
  for (const row of rows) if (row.draftId && !map.has(row.draftId)) map.set(row.draftId, row);
  return map;
}

/** What Home shows: approved, scheduled (soon), in flight, or failed recently */
export async function publicationsForHome(profileId: string, now: Date, limit = 8): Promise<XPublication[]> {
  return db
    .select()
    .from(t)
    .where(
      and(
        eq(t.profileId, profileId),
        or(
          inArray(t.status, ["approved", "publishing", "unknown"]),
          and(eq(t.status, "scheduled"), lte(t.scheduledAt, new Date(now.getTime() + 7 * 86_400_000))),
          and(eq(t.status, "failed"), gte(t.updatedAt, new Date(now.getTime() - 7 * 86_400_000))),
        ),
      ),
    )
    .orderBy(sql`${t.scheduledAt} asc nulls first`, desc(t.createdAt))
    .limit(limit);
}

/** A new approval of exact text. Null when the draft already has a live one (unique index). */
export async function insertPublication(values: Pick<XPublication, "profileId" | "draftId" | "xUserId" | "text" | "hasUrl">): Promise<XPublication | null> {
  const [row] = await db
    .insert(t)
    .values({ ...values, status: "approved" })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Moves a publication between states only from the expected ones. Null: someone else moved it first. */
export async function transitionPublication(
  profileId: string,
  id: string,
  from: PublicationStatus[],
  patch: Partial<Omit<XPublication, "id" | "profileId" | "createdAt" | "updatedAt">>,
): Promise<XPublication | null> {
  const [row] = await db
    .update(t)
    .set(patch)
    .where(and(eq(t.profileId, profileId), eq(t.id, id), inArray(t.status, from)))
    .returning();
  return row ?? null;
}

/**
 * The one worker that may call X for this publication: status → publishing
 * with a short lease, only from a publishable state and when no lease holds.
 */
export async function claimPublication(profileId: string, id: string, from: PublicationStatus[], now: Date, leaseMs = 120_000): Promise<XPublication | null> {
  const [row] = await db
    .update(t)
    .set({ status: "publishing", claimedUntil: new Date(now.getTime() + leaseMs), attempts: sql`${t.attempts} + 1`, attemptedAt: now, error: null })
    .where(and(eq(t.profileId, profileId), eq(t.id, id), inArray(t.status, from), or(isNull(t.claimedUntil), lt(t.claimedUntil, now))))
    .returning();
  return row ?? null;
}

/**
 * Takes a free slot of the plan's window (unique per profile, window and
 * slot), so concurrent publishes can't pass the plan's count. False: full.
 */
export async function takeWindowSlot(profileId: string, id: string, windowStart: string, max: number): Promise<boolean> {
  for (let slot = 0; slot < max; slot++) {
    try {
      const rows = await db
        .update(t)
        .set({ windowStart, windowSlot: slot })
        .where(and(eq(t.profileId, profileId), eq(t.id, id)))
        .returning({ id: t.id });
      if (rows.length) return true;
      return false;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return false;
}

/** Posts counted in a window (slots held), for the scheduling check */
export async function slotsUsed(profileId: string, windowStart: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.profileId, profileId), eq(t.windowStart, windowStart)));
  return row?.n ?? 0;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/** Reserves `usd` of the month's publishing allowance in one statement; false when it would pass the cap */
export async function reservePublishSpend(profileId: string, month: string, usd: number, capUsd: number): Promise<boolean> {
  const b = xPublishBudgetsTable;
  const result = await db.execute(sql`
    insert into ${b} ("profileId", "month", "committedUsd")
    select ${profileId}::uuid, ${month}::date, ${usd}::float8
    where ${usd}::float8 <= ${capUsd}::float8
    on conflict ("profileId", "month") do update
      set "committedUsd" = ${b}."committedUsd" + excluded."committedUsd", "updatedAt" = now()
      where ${b}."committedUsd" + excluded."committedUsd" <= ${capUsd}::float8
    returning "id"
  `);
  return result.rows.length > 0;
}

/** Gives back (negative) or confirms an amount */
export async function adjustPublishSpend(profileId: string, month: string, deltaUsd: number): Promise<void> {
  const b = xPublishBudgetsTable;
  await db
    .update(b)
    .set({ committedUsd: sql`greatest(0, ${b.committedUsd} + ${deltaUsd}::float8)` })
    .where(and(eq(b.profileId, profileId), eq(b.month, month)));
}

export async function publishSpend(profileId: string, month: string): Promise<number> {
  const b = xPublishBudgetsTable;
  const [row] = await db.select({ usd: b.committedUsd }).from(b).where(and(eq(b.profileId, profileId), eq(b.month, month))).limit(1);
  return row?.usd ?? 0;
}

/** Scheduled posts due now (any profile): the scheduler's work */
export async function duePublications(now: Date, limit: number): Promise<XPublication[]> {
  return db
    .select()
    .from(t)
    .where(and(eq(t.status, "scheduled"), lte(t.scheduledAt, now), or(isNull(t.nextAttemptAt), lte(t.nextAttemptAt, now))))
    .orderBy(asc(t.scheduledAt))
    .limit(limit);
}

/** In flight past their lease (the worker died mid-request): their outcome is unknown */
export async function expiredPublishing(now: Date, limit: number): Promise<XPublication[]> {
  return db
    .select()
    .from(t)
    .where(and(eq(t.status, "publishing"), lt(t.claimedUntil, now)))
    .limit(limit);
}

/** Unanswered requests old enough to look for on the user's timeline */
export async function unknownToReconcile(now: Date, olderThanMs: number, limit: number): Promise<XPublication[]> {
  return db
    .select()
    .from(t)
    .where(and(eq(t.status, "unknown"), lt(t.attemptedAt, new Date(now.getTime() - olderThanMs)), or(isNull(t.claimedUntil), lt(t.claimedUntil, now))))
    .orderBy(asc(t.attemptedAt))
    .limit(limit);
}

/**
 * Consent ends (X disconnected, another account connected): approvals and
 * schedules are cancelled. Posts already in flight keep their state, so
 * their outcome is still recorded.
 */
export async function cancelActivePublications(profileId: string, reason: string): Promise<number> {
  const rows = await db
    .update(t)
    .set({ status: "cancelled", error: reason, scheduledAt: null })
    .where(and(eq(t.profileId, profileId), inArray(t.status, ["approved", "scheduled"])))
    .returning({ id: t.id });
  return rows.length;
}

/**
 * The draft's text changed: an approval of other text no longer holds. The
 * publication is cancelled and the Inbox approval released, so the post
 * comes back as "Post ready" to approve again. Returns how many it cancelled.
 */
export async function invalidateApprovalsForDraft(profileId: string, draftId: string, newText: string): Promise<number> {
  const rows = await db
    .update(t)
    .set({ status: "cancelled", error: "Edited after approval: approve the new version.", scheduledAt: null })
    .where(and(eq(t.profileId, profileId), eq(t.draftId, draftId), inArray(t.status, ["approved", "scheduled"]), sql`${t.text} <> ${newText}`))
    .returning({ id: t.id });
  if (rows.length) {
    // "Ready" meant approved: the new text is a draft again until the user approves it
    await db.update(contentDraftsTable).set({ status: "draft" }).where(and(eq(contentDraftsTable.profileId, profileId), eq(contentDraftsTable.id, draftId)));
    await db
      .delete(inboxDecisionsTable)
      .where(and(eq(inboxDecisionsTable.profileId, profileId), eq(inboxDecisionsTable.itemKey, `draft:${draftId}`), eq(inboxDecisionsTable.decision, "approved")));
  }
  return rows.length;
}

/** Posts read while checking unanswered requests this period: they count in the plan's X reads */
export async function sumReconcileReads(profileId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sum(t.reconcileReads) })
    .from(t)
    .where(and(eq(t.profileId, profileId), gte(t.updatedAt, since)));
  return Number(row?.n ?? 0);
}

/** The profile's scheduled posts (for the window and month checks when scheduling) */
export async function scheduledPublications(profileId: string): Promise<XPublication[]> {
  return db.select().from(t).where(and(eq(t.profileId, profileId), eq(t.status, "scheduled")));
}

/** One checker at a time for an unanswered request (a short lease; the status stays "unknown") */
export async function leaseUnknown(id: string, now: Date, leaseMs = 120_000): Promise<XPublication | null> {
  const [row] = await db
    .update(t)
    .set({ claimedUntil: new Date(now.getTime() + leaseMs) })
    .where(and(eq(t.id, id), eq(t.status, "unknown"), or(isNull(t.claimedUntil), lt(t.claimedUntil, now))))
    .returning();
  return row ?? null;
}

/** Posts X is processing for this profile right now (account deletion waits for them) */
export async function countPublishing(profileId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.profileId, profileId), eq(t.status, "publishing")));
  return row?.n ?? 0;
}
