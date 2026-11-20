import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import db from "@/db";
import {
  opportunitiesTable,
  type ScoutCandidate,
  scoutCandidatesTable,
  scoutRunsTable,
  type Trend,
  trendsTable,
} from "@/db/schema";
import type { TrendStatus } from "@/lib/trends/types";

// Day 29 Trend Scout. Every query is scoped by profileId.

/** Scored, relevant candidates of the observation period: the only input of trend detection */
export async function getTrendCandidates(profileId: string, since: Date): Promise<ScoutCandidate[]> {
  return db
    .select()
    .from(scoutCandidatesTable)
    .where(
      and(
        eq(scoutCandidatesTable.profileId, profileId),
        isNotNull(scoutCandidatesTable.scoredAt),
        isNotNull(scoutCandidatesTable.topic),
        isNull(scoutCandidatesTable.rejectedReason),
        isNull(scoutCandidatesTable.contentRemovedAt),
        gte(scoutCandidatesTable.postedAt, since),
      ),
    );
}

/** When this user's completed scans happened: windows are compared only when both were covered */
export async function getScanCoverage(profileId: string, windows: { currentStart: Date; previousStart: Date }) {
  const [row] = await db
    .select({
      first: sql<Date | null>`min(${scoutRunsTable.createdAt})`,
      current: sql<number>`count(*) filter (where ${scoutRunsTable.createdAt} >= ${windows.currentStart.toISOString()})::int`,
      previous: sql<number>`count(*) filter (where ${scoutRunsTable.createdAt} >= ${windows.previousStart.toISOString()} and ${scoutRunsTable.createdAt} < ${windows.currentStart.toISOString()})::int`,
    })
    .from(scoutRunsTable)
    // The scan computing trends is still running: it counts as coverage too
    .where(and(eq(scoutRunsTable.profileId, profileId), inArray(scoutRunsTable.status, ["completed", "running"])));
  return {
    collectingSince: row?.first ? new Date(row.first) : null,
    scansInCurrentWindow: row?.current ?? 0,
    scansInPreviousWindow: row?.previous ?? 0,
  };
}

/** What a recompute writes: never the user's choices (saved) or the cached insight */
export type TrendValues = Omit<
  typeof trendsTable.$inferInsert,
  "id" | "profileId" | "createdAt" | "updatedAt" | "saved" | "insight" | "insightGeneratedAt" | "insightBasis" | "insightLockedUntil"
>;

/**
 * Replaces the user's trends with a fresh computation: same key → same row
 * (and ID), trends no longer supported by recent posts are removed.
 */
export async function replaceTrends(profileId: string, trends: TrendValues[]): Promise<void> {
  const keys = trends.map((trend) => trend.key);
  const queries: [BatchItem<"pg">, ...BatchItem<"pg">[]] = [
    // Saved trends stay, even when they go quiet; the user decides when to drop them
    keys.length
      ? db
          .delete(trendsTable)
          .where(and(eq(trendsTable.profileId, profileId), eq(trendsTable.saved, false), notInArray(trendsTable.key, keys)))
      : db.delete(trendsTable).where(and(eq(trendsTable.profileId, profileId), eq(trendsTable.saved, false))),
  ];
  for (const trend of trends) {
    queries.push(
      db
        .insert(trendsTable)
        .values({ ...trend, profileId })
        .onConflictDoUpdate({ target: [trendsTable.profileId, trendsTable.key], set: { ...trend, updatedAt: new Date() } }),
    );
  }
  // One transaction: readers never see a half-replaced set
  await db.batch(queries);
}

export type TrendFilters = { topicId?: string; minRelevance?: number; status?: TrendStatus; recentHours?: number; saved?: boolean };

export async function getTrends(profileId: string, filters: TrendFilters): Promise<Trend[]> {
  const conditions = [eq(trendsTable.profileId, profileId)];
  if (filters.topicId) conditions.push(eq(trendsTable.discoveryTopicId, filters.topicId));
  if (filters.minRelevance) conditions.push(gte(trendsTable.relevance, filters.minRelevance));
  if (filters.status) conditions.push(eq(trendsTable.status, filters.status));
  if (filters.recentHours) conditions.push(gte(trendsTable.lastPostAt, new Date(Date.now() - filters.recentHours * 3_600_000)));
  if (filters.saved) conditions.push(eq(trendsTable.saved, true));
  return db
    .select()
    .from(trendsTable)
    .where(and(...conditions))
    // Worth your attention first: opportunity, then overall trend strength
    .orderBy(desc(trendsTable.opportunityScore), desc(trendsTable.score), desc(trendsTable.lastPostAt));
}

export async function getTrend(profileId: string, id: string): Promise<Trend | undefined> {
  const [row] = await db.select().from(trendsTable).where(and(eq(trendsTable.id, id), eq(trendsTable.profileId, profileId)));
  return row;
}

/** The representative posts, with the opportunity each became (if any) */
export async function getTrendPosts(profileId: string, candidateIds: string[]) {
  if (candidateIds.length === 0) return [];
  const candidates = await db
    .select()
    .from(scoutCandidatesTable)
    // Day 40.1: removed posts are neither shown nor sent to the AI
    .where(and(eq(scoutCandidatesTable.profileId, profileId), inArray(scoutCandidatesTable.id, candidateIds), isNull(scoutCandidatesTable.contentRemovedAt)))
    .orderBy(desc(scoutCandidatesTable.score), asc(scoutCandidatesTable.postedAt));
  const opportunities = await db
    .select({ id: opportunitiesTable.id, platformPostId: opportunitiesTable.platformPostId })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.profileId, profileId),
        inArray(
          opportunitiesTable.platformPostId,
          candidates.map((candidate) => candidate.platformPostId),
        ),
      ),
    );
  const byPost = new Map(opportunities.map((item) => [item.platformPostId, item.id]));
  return candidates.map((candidate) => ({ candidate, opportunityId: byPost.get(candidate.platformPostId) ?? null }));
}

/** Posts (by X ID) that are opportunities the user can still act on */
export async function getOpenOpportunityPostIds(profileId: string, platformPostIds: string[]): Promise<Set<string>> {
  if (platformPostIds.length === 0) return new Set();
  const rows = await db
    .select({ platformPostId: opportunitiesTable.platformPostId })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.profileId, profileId),
        inArray(opportunitiesTable.platformPostId, platformPostIds),
        inArray(opportunitiesTable.status, ["new", "saved"]),
      ),
    );
  return new Set(rows.map((row) => row.platformPostId));
}

export async function setTrendSaved(profileId: string, id: string, saved: boolean): Promise<boolean> {
  const rows = await db
    .update(trendsTable)
    .set({ saved })
    .where(and(eq(trendsTable.id, id), eq(trendsTable.profileId, profileId)))
    .returning({ id: trendsTable.id });
  return rows.length > 0;
}

/** Takes the trend's generation lock; false when another generation is running */
export async function lockTrendInsight(profileId: string, id: string, seconds: number): Promise<boolean> {
  const rows = await db
    .update(trendsTable)
    .set({ insightLockedUntil: new Date(Date.now() + seconds * 1000) })
    .where(
      and(
        eq(trendsTable.id, id),
        eq(trendsTable.profileId, profileId),
        sql`(${trendsTable.insightLockedUntil} is null or ${trendsTable.insightLockedUntil} < now())`,
      ),
    )
    .returning({ id: trendsTable.id });
  return rows.length > 0;
}

export async function saveTrendInsight(
  profileId: string,
  id: string,
  insight: NonNullable<Trend["insight"]>,
  basis: NonNullable<Trend["insightBasis"]>,
): Promise<void> {
  await db
    .update(trendsTable)
    .set({ insight, insightBasis: basis, insightGeneratedAt: new Date(), insightLockedUntil: null })
    .where(and(eq(trendsTable.id, id), eq(trendsTable.profileId, profileId)));
}

export async function unlockTrendInsight(profileId: string, id: string): Promise<void> {
  await db
    .update(trendsTable)
    .set({ insightLockedUntil: null })
    .where(and(eq(trendsTable.id, id), eq(trendsTable.profileId, profileId)));
}
