import "server-only";

import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

import db from "@/db";
import {
  analyticsEventsTable,
  automationItemsTable,
  importedPostsTable,
  leadsTable,
  opportunitiesTable,
  scoutCandidatesTable,
  type XComplianceJob,
  xComplianceJobsTable,
  xPostsTable,
} from "@/db/schema";
import type { THIRD_PARTY_RETENTION_DAYS } from "@/lib/compliance/retention";

// Day 40.1 X content compliance. Removing content keeps the post ID, link
// and the user's own data around it (status, notes, their reply); it clears
// the third-party text and the AI text written about it.

export type RemovalReason = "deleted" | "protected" | "suspended" | "deactivated" | "edited" | "request" | "retention";

export type RemovalCounts = { cache: number; candidates: number; opportunities: number; leads: number; imported: number; snippets: number };

const DAY = 86_400_000;

/**
 * Removes stored content of these posts (by post ID) or of everything these
 * authors posted (by X user ID), in every user's data and the shared cache.
 */
export async function removeXContent(
  target: { postIds?: string[]; authorIds?: string[] },
  reason: RemovalReason,
  now = new Date(),
): Promise<RemovalCounts> {
  const postIds = [...new Set(target.postIds ?? [])];
  const authorIds = [...new Set(target.authorIds ?? [])];
  const counts: RemovalCounts = { cache: 0, candidates: 0, opportunities: 0, leads: 0, imported: 0, snippets: 0 };
  if (postIds.length === 0 && authorIds.length === 0) return counts;

  const match = (postCol: typeof xPostsTable.platformPostId, authorCol: typeof xPostsTable.authorPlatformUserId | null) =>
    sql`(${postIds.length ? inArray(postCol, postIds) : sql`false`} or ${authorCol && authorIds.length ? inArray(authorCol, authorIds) : sql`false`})`;
  const removed = { contentRemovedAt: now, contentRemovedReason: reason };

  counts.cache = (
    await db
      .delete(xPostsTable)
      .where(match(xPostsTable.platformPostId, xPostsTable.authorPlatformUserId))
      .returning({ id: xPostsTable.platformPostId })
  ).length;
  // Imported posts carry no author ID: by post ID only
  if (postIds.length) {
    counts.imported = (await db.delete(importedPostsTable).where(inArray(importedPostsTable.platformPostId, postIds)).returning({ id: importedPostsTable.id })).length;
  }
  counts.candidates = (
    await db
      .update(scoutCandidatesTable)
      .set({ content: "", reason: null, suggestedAngle: null, ...removed })
      .where(and(isNull(scoutCandidatesTable.contentRemovedAt), match(scoutCandidatesTable.platformPostId as never, scoutCandidatesTable.authorPlatformUserId as never)))
      .returning({ id: scoutCandidatesTable.id })
  ).length;
  const opportunities = await db
    .update(opportunitiesTable)
    .set({ content: "", reason: null, suggestedAngle: null, ...removed })
    .where(and(isNull(opportunitiesTable.contentRemovedAt), match(opportunitiesTable.platformPostId as never, opportunitiesTable.authorPlatformUserId as never)))
    .returning({ id: opportunitiesTable.id });
  const leads = await db
    .update(leadsTable)
    .set({ content: "", evidence: "", reason: "", ...removed })
    .where(and(isNull(leadsTable.contentRemovedAt), match(leadsTable.platformPostId as never, leadsTable.authorPlatformUserId as never)))
    .returning({ id: leadsTable.id });
  counts.opportunities = opportunities.length;
  counts.leads = leads.length;
  counts.snippets = await clearSnippets([...opportunities, ...leads].map((row) => row.id));
  return counts;
}

/** Notification and review-item snippets of removed posts */
async function clearSnippets(entityIds: string[]): Promise<number> {
  if (entityIds.length === 0) return 0;
  const rows = await db
    .update(automationItemsTable)
    .set({ body: null })
    .where(and(inArray(automationItemsTable.entityId, entityIds), isNotNull(automationItemsTable.body)))
    .returning({ id: automationItemsTable.id });
  return rows.length;
}

/**
 * Retention: removes third-party text older than Scout keeps it, in bounded
 * batches (each pass at most `batch` rows per table; the next tick continues).
 */
export async function expireThirdPartyContent(days: typeof THIRD_PARTY_RETENTION_DAYS, now: Date, batch: number): Promise<RemovalCounts> {
  const before = (d: number) => new Date(now.getTime() - d * DAY);
  const removed = { contentRemovedAt: now, contentRemovedReason: "retention" as const };

  const candidates = await db
    .update(scoutCandidatesTable)
    .set({ content: "", reason: null, suggestedAngle: null, ...removed })
    .where(
      inArray(
        scoutCandidatesTable.id,
        db
          .select({ id: scoutCandidatesTable.id })
          .from(scoutCandidatesTable)
          .where(and(isNull(scoutCandidatesTable.contentRemovedAt), lt(scoutCandidatesTable.postedAt, before(days.candidates))))
          .limit(batch),
      ),
    )
    .returning({ id: scoutCandidatesTable.id });
  const opportunities = await db
    .update(opportunitiesTable)
    .set({ content: "", reason: null, suggestedAngle: null, ...removed })
    .where(
      inArray(
        opportunitiesTable.id,
        db
          .select({ id: opportunitiesTable.id })
          .from(opportunitiesTable)
          .where(and(isNull(opportunitiesTable.contentRemovedAt), lt(sql`coalesce(${opportunitiesTable.postedAt}, ${opportunitiesTable.createdAt})`, before(days.opportunities))))
          .limit(batch),
      ),
    )
    .returning({ id: opportunitiesTable.id });
  const leads = await db
    .update(leadsTable)
    .set({ content: "", evidence: "", reason: "", ...removed })
    .where(
      inArray(
        leadsTable.id,
        db
          .select({ id: leadsTable.id })
          .from(leadsTable)
          .where(and(isNull(leadsTable.contentRemovedAt), lt(leadsTable.postedAt, before(days.leads))))
          .limit(batch),
      ),
    )
    .returning({ id: leadsTable.id });
  const imported = await db
    .delete(importedPostsTable)
    .where(
      inArray(
        importedPostsTable.id,
        db.select({ id: importedPostsTable.id }).from(importedPostsTable).where(lt(importedPostsTable.postedAt, before(days.imported))).limit(batch),
      ),
    )
    .returning({ id: importedPostsTable.id });
  // Snippets of posts in automation items, after their own window
  const snippets = await db
    .update(automationItemsTable)
    .set({ body: null })
    .where(
      inArray(
        automationItemsTable.id,
        db
          .select({ id: automationItemsTable.id })
          .from(automationItemsTable)
          .where(
            and(
              isNotNull(automationItemsTable.body),
              inArray(automationItemsTable.entityType, ["opportunity", "lead"]),
              lt(automationItemsTable.createdAt, before(days.automationSnippets)),
            ),
          )
          .limit(batch),
      ),
    )
    .returning({ id: automationItemsTable.id });
  return {
    cache: 0,
    candidates: candidates.length,
    opportunities: opportunities.length,
    leads: leads.length,
    imported: imported.length,
    snippets: snippets.length,
  };
}

/** Analytics events older than `days` (bounded) */
export async function deleteOldAnalyticsEvents(days: number, now: Date, batch: number): Promise<number> {
  const rows = await db
    .delete(analyticsEventsTable)
    .where(
      inArray(
        analyticsEventsTable.id,
        db
          .select({ id: analyticsEventsTable.id })
          .from(analyticsEventsTable)
          .where(lt(analyticsEventsTable.createdAt, new Date(now.getTime() - days * DAY)))
          .limit(batch),
      ),
    )
    .returning({ id: analyticsEventsTable.id });
  return rows.length;
}

// ---- Batch compliance jobs ----------------------------------------------------------

/** IDs of posts (or their authors) whose content Scout still stores, for a compliance job */
export async function storedXIds(type: "tweets" | "users", limit: number): Promise<string[]> {
  const result =
    type === "tweets"
      ? await db.execute<{ id: string }>(sql`
          select id from (
            select "platformPostId" as id from ${xPostsTable}
            union select "platformPostId" from ${scoutCandidatesTable} where "contentRemovedAt" is null
            union select "platformPostId" from ${opportunitiesTable} where "contentRemovedAt" is null
            union select "platformPostId" from ${leadsTable} where "contentRemovedAt" is null
          ) ids where id ~ '^[0-9]+$' limit ${limit}
        `)
      : await db.execute<{ id: string }>(sql`
          select id from (
            select "authorPlatformUserId" as id from ${xPostsTable}
            union select "authorPlatformUserId" from ${scoutCandidatesTable} where "contentRemovedAt" is null
            union select "authorPlatformUserId" from ${opportunitiesTable} where "contentRemovedAt" is null
            union select "authorPlatformUserId" from ${leadsTable} where "contentRemovedAt" is null
          ) ids where id ~ '^[0-9]+$' limit ${limit}
        `);
  return result.rows.map((row) => String(row.id));
}

export async function latestComplianceJob(type: "tweets" | "users"): Promise<XComplianceJob | undefined> {
  const [row] = await db.select().from(xComplianceJobsTable).where(eq(xComplianceJobsTable.type, type)).orderBy(desc(xComplianceJobsTable.createdAt)).limit(1);
  return row;
}

export async function insertComplianceJob(values: Pick<XComplianceJob, "type" | "xJobId" | "status" | "idCount" | "downloadUrl">): Promise<XComplianceJob> {
  const [row] = await db.insert(xComplianceJobsTable).values(values).returning();
  return row;
}

export async function updateComplianceJob(id: string, patch: Partial<Omit<XComplianceJob, "id" | "createdAt">>): Promise<void> {
  await db.update(xComplianceJobsTable).set(patch).where(eq(xComplianceJobsTable.id, id));
}
