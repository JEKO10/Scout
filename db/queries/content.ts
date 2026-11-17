import "server-only";

import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import db from "@/db";
import {
  aiUsageTable,
  type ContentDraft,
  contentDraftsTable,
  discoveryTopicsTable,
  leadsTable,
  notificationSettingsTable,
  type Trend,
  trendsTable,
} from "@/db/schema";
import type { DraftStatus } from "@/lib/content/types";

// Day 31 Content Studio. Every query is scoped by profileId.

export type DraftValues = Omit<typeof contentDraftsTable.$inferInsert, "id" | "profileId" | "createdAt" | "updatedAt">;

export async function insertDraft(profileId: string, values: DraftValues): Promise<ContentDraft> {
  const [row] = await db.insert(contentDraftsTable).values({ ...values, profileId }).returning();
  return row;
}

export async function getDraft(profileId: string, id: string): Promise<ContentDraft | undefined> {
  const [row] = await db
    .select()
    .from(contentDraftsTable)
    .where(and(eq(contentDraftsTable.id, id), eq(contentDraftsTable.profileId, profileId)));
  return row;
}

export async function getDrafts(
  profileId: string,
  { q, status, archived = false }: { q?: string; status?: DraftStatus; archived?: boolean } = {},
  limit = 100,
) {
  const conditions = [
    eq(contentDraftsTable.profileId, profileId),
    archived ? isNotNull(contentDraftsTable.archivedAt) : isNull(contentDraftsTable.archivedAt),
  ];
  if (status) conditions.push(eq(contentDraftsTable.status, status));
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(contentDraftsTable.title, pattern), sql`array_to_string(${contentDraftsTable.posts}, ' ') ilike ${pattern}`)!);
  }
  return db
    .select()
    .from(contentDraftsTable)
    .where(and(...conditions))
    .orderBy(desc(contentDraftsTable.updatedAt))
    .limit(limit);
}

export async function updateDraft(profileId: string, id: string, values: Partial<DraftValues>): Promise<ContentDraft | null> {
  const [row] = await db
    .update(contentDraftsTable)
    .set(values)
    .where(and(eq(contentDraftsTable.id, id), eq(contentDraftsTable.profileId, profileId)))
    .returning();
  return row ?? null;
}

export async function deleteDraft(profileId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(contentDraftsTable)
    .where(and(eq(contentDraftsTable.id, id), eq(contentDraftsTable.profileId, profileId)))
    .returning({ id: contentDraftsTable.id });
  return rows.length > 0;
}

/** The newest Content Studio AI call: one at a time, no rapid repeats */
export async function lastContentAiCallAt(profileId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${aiUsageTable.createdAt})` })
    .from(aiUsageTable)
    .where(
      and(
        eq(aiUsageTable.profileId, profileId),
        inArray(aiUsageTable.operation, ["content_ideas", "content_generation", "content_review"]),
      ),
    );
  return row?.at ? new Date(row.at) : null;
}

/** Context for ideas: saved trends first, then the best-opportunity ones (stored data only) */
export async function getTrendsForContent(profileId: string, limit = 4): Promise<Trend[]> {
  return db
    .select()
    .from(trendsTable)
    .where(eq(trendsTable.profileId, profileId))
    .orderBy(desc(trendsTable.saved), desc(trendsTable.opportunityScore))
    .limit(limit);
}

export async function getDiscoveryTopicNames(profileId: string): Promise<string[]> {
  const rows = await db
    .select({ name: discoveryTopicsTable.name, description: discoveryTopicsTable.description })
    .from(discoveryTopicsTable)
    .where(and(eq(discoveryTopicsTable.profileId, profileId), eq(discoveryTopicsTable.isActive, true)));
  return rows.map((row) => (row.description ? `${row.name}: ${row.description}` : row.name));
}

/**
 * Recurring customer problems, from Lead Scout's own summaries of public
 * posts: no handles, no post text, no CRM notes, so nothing identifiable
 * reaches a generated public post.
 */
export async function getRecentLeadProblems(profileId: string, limit = 8): Promise<string[]> {
  const rows = await db
    .select({ reason: leadsTable.reason })
    .from(leadsTable)
    .where(eq(leadsTable.profileId, profileId))
    .orderBy(desc(leadsTable.createdAt))
    .limit(limit);
  return rows.map((row) => row.reason);
}

// ---- Day 32 Content Calendar -------------------------------------------------

/** Planned drafts in a UTC range (not archived), soonest first */
export async function getPlannedDrafts(profileId: string, from: Date, to: Date): Promise<ContentDraft[]> {
  return db
    .select()
    .from(contentDraftsTable)
    .where(
      and(
        eq(contentDraftsTable.profileId, profileId),
        isNull(contentDraftsTable.archivedAt),
        gte(contentDraftsTable.plannedAt, from),
        lt(contentDraftsTable.plannedAt, to),
      ),
    )
    .orderBy(asc(contentDraftsTable.plannedAt));
}

/** Drafts with no date that aren't posted or archived: what could go on the calendar */
export async function getUnplannedDrafts(profileId: string, limit = 50): Promise<ContentDraft[]> {
  return db
    .select()
    .from(contentDraftsTable)
    .where(
      and(
        eq(contentDraftsTable.profileId, profileId),
        isNull(contentDraftsTable.plannedAt),
        isNull(contentDraftsTable.archivedAt),
        isNull(contentDraftsTable.publishedConfirmedAt),
      ),
    )
    .orderBy(desc(contentDraftsTable.updatedAt))
    .limit(limit);
}

/** Planned, past due, not confirmed and not yet recorded as missed */
export async function getNewlyMissed(profileId: string, now: Date): Promise<ContentDraft[]> {
  return db
    .select()
    .from(contentDraftsTable)
    .where(
      and(
        eq(contentDraftsTable.profileId, profileId),
        lt(contentDraftsTable.plannedAt, now),
        isNull(contentDraftsTable.publishedConfirmedAt),
        isNull(contentDraftsTable.archivedAt),
        isNull(contentDraftsTable.missedNotedAt),
      ),
    );
}

export async function markMissedNoted(profileId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(contentDraftsTable)
    .set({ missedNotedAt: new Date() })
    .where(and(eq(contentDraftsTable.profileId, profileId), inArray(contentDraftsTable.id, ids)));
}

/** The time zone the user set for notifications, if any */
export async function getProfileTimeZone(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ tz: notificationSettingsTable.timezone })
    .from(notificationSettingsTable)
    .where(eq(notificationSettingsTable.profileId, profileId));
  return row?.tz ?? null;
}

/** Saved trends no draft was written from yet */
export async function getSavedTrendsWithoutContent(profileId: string): Promise<string[]> {
  const rows = await db
    .select({ label: trendsTable.label })
    .from(trendsTable)
    .where(
      and(
        eq(trendsTable.profileId, profileId),
        eq(trendsTable.saved, true),
        sql`not exists (select 1 from ${contentDraftsTable} d where d."sourceTrendId" = ${trendsTable.id} and d."profileId" = ${profileId})`,
      ),
    );
  return rows.map((row) => row.label);
}
