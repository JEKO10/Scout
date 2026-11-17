import "server-only";

import { and, asc, count, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";

import db from "@/db";
import {
  type Lead,
  leadActivitiesTable,
  type LeadActivity,
  type LeadNote,
  leadNotesTable,
  leadsTable,
} from "@/db/schema";
import type { LeadStatus } from "@/lib/leads/crm";
import type { LeadIntent } from "@/lib/leads/types";

// Day 28 CRM. Every query is scoped by profileId: a lead, its notes and its
// history are only ever read or changed by their owner.

type ActivityKind = LeadActivity["kind"];

export async function addLeadActivity(
  profileId: string,
  leadId: string,
  kind: ActivityKind,
  { userEntered = false, detail = null }: { userEntered?: boolean; detail?: LeadActivity["detail"] } = {},
): Promise<void> {
  await db.batch([
    db.insert(leadActivitiesTable).values({ profileId, leadId, kind, userEntered, detail }),
    db
      .update(leadsTable)
      .set({ lastActivityAt: new Date() })
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.profileId, profileId))),
  ]);
}

export async function countSavedLeads(profileId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.profileId, profileId), eq(leadsTable.saved, true)));
  return row?.n ?? 0;
}

export type CrmSort = "score" | "intent" | "recent" | "follow_up";
export type CrmFilters = { q?: string; status?: LeadStatus; intent?: LeadIntent; sort?: CrmSort };

/** Saved leads for the CRM views; search covers the handle and the post */
export async function getCrmLeads(profileId: string, filters: CrmFilters, limit = 300): Promise<Lead[]> {
  const conditions = [eq(leadsTable.profileId, profileId), eq(leadsTable.saved, true)];
  if (filters.status) conditions.push(eq(leadsTable.status, filters.status));
  if (filters.intent) conditions.push(eq(leadsTable.intent, filters.intent));
  if (filters.q) {
    const pattern = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(leadsTable.authorHandle, pattern), ilike(leadsTable.content, pattern))!);
  }
  const order =
    filters.sort === "recent"
      ? [desc(leadsTable.createdAt)]
      : filters.sort === "follow_up"
        ? [sql`${leadsTable.followUpAt} asc nulls last`, desc(leadsTable.score)]
        : filters.sort === "intent"
          ? [sql`case ${leadsTable.intent} when 'high' then 0 when 'medium' then 1 else 2 end`, desc(leadsTable.score)]
          : [desc(leadsTable.score), desc(leadsTable.createdAt)];
  return db
    .select()
    .from(leadsTable)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit);
}

export async function getCrmLead(
  profileId: string,
  id: string,
): Promise<{ lead: Lead; notes: LeadNote[]; activities: LeadActivity[] } | null> {
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), eq(leadsTable.profileId, profileId)));
  if (!lead) return null;
  const [notes, activities] = await Promise.all([
    db
      .select()
      .from(leadNotesTable)
      .where(and(eq(leadNotesTable.leadId, id), eq(leadNotesTable.profileId, profileId)))
      .orderBy(desc(leadNotesTable.createdAt)),
    db
      .select()
      .from(leadActivitiesTable)
      .where(and(eq(leadActivitiesTable.leadId, id), eq(leadActivitiesTable.profileId, profileId)))
      .orderBy(desc(leadActivitiesTable.createdAt)),
  ]);
  return { lead, notes, activities };
}

/** Activity kinds per lead, for the next-best-action rules in list views */
export async function getActivityKinds(profileId: string, leadIds: string[]): Promise<Map<string, string[]>> {
  if (leadIds.length === 0) return new Map();
  const rows = await db
    .select({ leadId: leadActivitiesTable.leadId, kind: leadActivitiesTable.kind })
    .from(leadActivitiesTable)
    .where(and(eq(leadActivitiesTable.profileId, profileId), inArray(leadActivitiesTable.leadId, leadIds)));
  const map = new Map<string, string[]>();
  for (const row of rows) map.set(row.leadId, [...(map.get(row.leadId) ?? []), row.kind]);
  return map;
}

async function updateOwnedLead(profileId: string, id: string, values: Partial<typeof leadsTable.$inferInsert>) {
  const rows = await db
    .update(leadsTable)
    .set(values)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.profileId, profileId)))
    .returning();
  return rows[0] ?? null;
}

export const setLeadStatus = (profileId: string, id: string, status: LeadStatus) => updateOwnedLead(profileId, id, { status });
export const setLeadSavedFlag = (profileId: string, id: string, saved: boolean) => updateOwnedLead(profileId, id, { saved });
export const setLeadFollowUp = (profileId: string, id: string, followUpAt: Date | null, followUpNote: string | null) =>
  updateOwnedLead(profileId, id, { followUpAt, followUpNote, followUpDoneAt: null });
export const completeLeadFollowUp = (profileId: string, id: string) =>
  updateOwnedLead(profileId, id, { followUpDoneAt: new Date() });

export async function deleteLead(profileId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(leadsTable)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.profileId, profileId)))
    .returning({ id: leadsTable.id });
  return rows.length > 0;
}

export async function insertLeadNote(profileId: string, leadId: string, body: string): Promise<void> {
  await db.insert(leadNotesTable).values({ profileId, leadId, body });
}

export async function updateLeadNote(profileId: string, noteId: string, body: string): Promise<boolean> {
  const rows = await db
    .update(leadNotesTable)
    .set({ body })
    .where(and(eq(leadNotesTable.id, noteId), eq(leadNotesTable.profileId, profileId)))
    .returning({ id: leadNotesTable.id });
  return rows.length > 0;
}

export async function deleteLeadNote(profileId: string, noteId: string): Promise<boolean> {
  const rows = await db
    .delete(leadNotesTable)
    .where(and(eq(leadNotesTable.id, noteId), eq(leadNotesTable.profileId, profileId)))
    .returning({ id: leadNotesTable.id });
  return rows.length > 0;
}

/** A saved lead for the same X account: new buying signals from them attach to it */
export async function findSavedLeadByAuthor(profileId: string, authorPlatformUserId: string): Promise<Lead | undefined> {
  const [row] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.profileId, profileId),
        eq(leadsTable.saved, true),
        eq(leadsTable.authorPlatformUserId, authorPlatformUserId),
      ),
    )
    .orderBy(asc(leadsTable.createdAt))
    .limit(1);
  return row;
}

/** Counts for the CRM overview, from stored data */
export async function getCrmMetrics(profileId: string) {
  const [row] = await db
    .select({
      saved: count(),
      high: sql<number>`count(*) filter (where ${leadsTable.intent} = 'high')::int`,
      contacted: sql<number>`count(*) filter (where ${leadsTable.status} in ('contacted','replied','qualified','won','lost'))::int`,
      qualified: sql<number>`count(*) filter (where ${leadsTable.status} in ('qualified','won'))::int`,
      won: sql<number>`count(*) filter (where ${leadsTable.status} = 'won')::int`,
      lost: sql<number>`count(*) filter (where ${leadsTable.status} = 'lost')::int`,
      awaiting: sql<number>`count(*) filter (where ${leadsTable.status} = 'new' and ${leadsTable.lastActivityAt} is null)::int`,
      followUpsDue: sql<number>`count(*) filter (where ${leadsTable.followUpAt} is not null and ${leadsTable.followUpAt} < date_trunc('day', now() at time zone 'utc') + interval '1 day' and (${leadsTable.followUpDoneAt} is null or ${leadsTable.followUpDoneAt} < ${leadsTable.followUpAt}) and ${leadsTable.status} not in ('won','lost'))::int`,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.profileId, profileId), eq(leadsTable.saved, true)));
  const byStatus = await db
    .select({ status: leadsTable.status, n: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.profileId, profileId), eq(leadsTable.saved, true)))
    .groupBy(leadsTable.status);
  const [done] = await db
    .select({ n: count() })
    .from(leadActivitiesTable)
    .where(and(eq(leadActivitiesTable.profileId, profileId), eq(leadActivitiesTable.kind, "follow_up_done")));
  return {
    saved: row?.saved ?? 0,
    high: row?.high ?? 0,
    contacted: row?.contacted ?? 0,
    qualified: row?.qualified ?? 0,
    won: row?.won ?? 0,
    lost: row?.lost ?? 0,
    awaiting: row?.awaiting ?? 0,
    followUpsDue: row?.followUpsDue ?? 0,
    followUpsCompleted: done?.n ?? 0,
    byStatus: Object.fromEntries(byStatus.map((item) => [item.status, item.n])) as Partial<Record<LeadStatus, number>>,
  };
}

/** Saved leads with a pending follow-up, soonest first */
export async function getFollowUps(profileId: string, limit = 20): Promise<Lead[]> {
  return db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.profileId, profileId),
        eq(leadsTable.saved, true),
        isNotNull(leadsTable.followUpAt),
        sql`(${leadsTable.followUpDoneAt} is null or ${leadsTable.followUpDoneAt} < ${leadsTable.followUpAt})`,
        sql`${leadsTable.status} not in ('won','lost')`,
      ),
    )
    .orderBy(asc(leadsTable.followUpAt))
    .limit(limit);
}
