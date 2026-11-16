import "server-only";

import { and, asc, count, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import db from "@/db";
import { type DiscoveryTopic, discoveryTopicsTable, opportunitiesTable } from "@/db/schema";

// Every query is scoped by profileId: a topic is only ever read or changed by its owner.

export type TopicValues = {
  name: string;
  description: string | null;
  keywords: string[];
  excludedKeywords: string[];
};

export async function getDiscoveryTopics(profileId: string): Promise<DiscoveryTopic[]> {
  return db
    .select()
    .from(discoveryTopicsTable)
    .where(eq(discoveryTopicsTable.profileId, profileId))
    .orderBy(asc(discoveryTopicsTable.createdAt));
}

/** Active topics, least recently searched first (the order budget is spent in) */
export async function getActiveDiscoveryTopics(profileId: string): Promise<DiscoveryTopic[]> {
  return db
    .select()
    .from(discoveryTopicsTable)
    .where(and(eq(discoveryTopicsTable.profileId, profileId), eq(discoveryTopicsTable.isActive, true)))
    .orderBy(sql`${discoveryTopicsTable.lastSearchedAt} asc nulls first`);
}

export async function countActiveDiscoveryTopics(profileId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(discoveryTopicsTable)
    .where(and(eq(discoveryTopicsTable.profileId, profileId), eq(discoveryTopicsTable.isActive, true)));
  return row?.n ?? 0;
}

export async function countDiscoveryTopics(profileId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(discoveryTopicsTable).where(eq(discoveryTopicsTable.profileId, profileId));
  return row?.n ?? 0;
}

export async function insertDiscoveryTopic(
  profileId: string,
  values: TopicValues & { isActive: boolean },
): Promise<DiscoveryTopic> {
  const [row] = await db.insert(discoveryTopicsTable).values({ profileId, ...values }).returning();
  return row;
}

/** Changing the search terms starts the topic's search fresh */
export async function updateDiscoveryTopic(profileId: string, id: string, values: TopicValues): Promise<boolean> {
  const rows = await db
    .update(discoveryTopicsTable)
    .set({ ...values, sinceId: null })
    .where(and(eq(discoveryTopicsTable.id, id), eq(discoveryTopicsTable.profileId, profileId)))
    .returning({ id: discoveryTopicsTable.id });
  return rows.length > 0;
}

export async function setDiscoveryTopicActive(profileId: string, id: string, isActive: boolean): Promise<boolean> {
  const rows = await db
    .update(discoveryTopicsTable)
    .set({ isActive })
    .where(and(eq(discoveryTopicsTable.id, id), eq(discoveryTopicsTable.profileId, profileId)))
    .returning({ id: discoveryTopicsTable.id });
  return rows.length > 0;
}

/** Deleting a topic keeps the opportunities it found (their source becomes unknown) */
export async function deleteDiscoveryTopic(profileId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(discoveryTopicsTable)
    .where(and(eq(discoveryTopicsTable.id, id), eq(discoveryTopicsTable.profileId, profileId)))
    .returning({ id: discoveryTopicsTable.id });
  return rows.length > 0;
}

/** After a search: only newer posts next time */
export async function markTopicSearched(id: string, sinceId: string | null, at: Date): Promise<void> {
  await db
    .update(discoveryTopicsTable)
    .set({ lastSearchedAt: at, ...(sinceId ? { sinceId } : {}) })
    .where(eq(discoveryTopicsTable.id, id));
}

export type DiscoveryFeedFilters = { topicId?: string; minScore?: number; sinceDays?: number };

/** Opportunities found by Smart Discovery, best first */
export async function getDiscoveryFeed(profileId: string, filters: DiscoveryFeedFilters, limit = 50) {
  const conditions = [
    eq(opportunitiesTable.profileId, profileId),
    isNotNull(opportunitiesTable.discoveryTopicId),
    sql`${opportunitiesTable.status} in ('new', 'saved', 'reply_opened')`,
  ];
  if (filters.topicId) conditions.push(eq(opportunitiesTable.discoveryTopicId, filters.topicId));
  if (filters.minScore) conditions.push(gte(opportunitiesTable.score, filters.minScore));
  if (filters.sinceDays) {
    conditions.push(gte(opportunitiesTable.createdAt, new Date(Date.now() - filters.sinceDays * 86_400_000)));
  }
  return db
    .select()
    .from(opportunitiesTable)
    .where(and(...conditions))
    .orderBy(desc(opportunitiesTable.score), desc(opportunitiesTable.createdAt))
    .limit(limit);
}
