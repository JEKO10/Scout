import "server-only";

import { and, count, desc, eq, gte } from "drizzle-orm";

import db from "@/db";
import { type Feedback, feedbackTable } from "@/db/schema";

export async function insertFeedback(values: typeof feedbackTable.$inferInsert): Promise<void> {
  await db.insert(feedbackTable).values(values);
}

/** How many times this profile sent feedback since a moment: the spam limit */
export async function countFeedbackSince(profileId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(feedbackTable)
    .where(and(eq(feedbackTable.profileId, profileId), gte(feedbackTable.createdAt, since)));
  return row?.n ?? 0;
}

/** Newest feedback from everyone, for the internal dashboard */
export async function getRecentFeedback(limit = 30): Promise<Feedback[]> {
  return db.select().from(feedbackTable).orderBy(desc(feedbackTable.createdAt)).limit(limit);
}
