import "server-only";

import { and, desc, eq, gte } from "drizzle-orm";

import db from "@/db";
import { opportunitiesTable, repliesTable } from "@/db/schema";

// Memory is assembled from behavior already on record: replies (what Scout
// wrote vs what the user kept) and opportunities (what they engaged with).

export async function getReplyHistory(profileId: string, since: Date) {
  return db
    .select({
      reply: {
        id: repliesTable.id,
        variant: repliesTable.variant,
        status: repliesTable.status,
        originalContent: repliesTable.originalContent,
        content: repliesTable.content,
        createdAt: repliesTable.createdAt,
        updatedAt: repliesTable.updatedAt,
      },
      opportunity: {
        id: opportunitiesTable.id,
        status: opportunitiesTable.status,
        authorHandle: opportunitiesTable.authorHandle,
        topic: opportunitiesTable.topic,
      },
    })
    .from(repliesTable)
    .innerJoin(opportunitiesTable, eq(repliesTable.opportunityId, opportunitiesTable.id))
    .where(
      and(eq(opportunitiesTable.profileId, profileId), gte(repliesTable.createdAt, since)),
    )
    .orderBy(desc(repliesTable.createdAt));
}

export type ReplyHistoryRow = Awaited<ReturnType<typeof getReplyHistory>>[number];

export async function getEngagementHistory(profileId: string, since: Date) {
  return db
    .select({
      id: opportunitiesTable.id,
      status: opportunitiesTable.status,
      topic: opportunitiesTable.topic,
      authorHandle: opportunitiesTable.authorHandle,
      updatedAt: opportunitiesTable.updatedAt,
    })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.profileId, profileId),
        gte(opportunitiesTable.updatedAt, since),
      ),
    );
}

export type EngagementRow = Awaited<ReturnType<typeof getEngagementHistory>>[number];
