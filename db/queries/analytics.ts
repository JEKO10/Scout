import "server-only";

import { count, countDistinct, gte } from "drizzle-orm";

import db from "@/db";
import { analyticsEventsTable } from "@/db/schema";

export async function insertAnalyticsEvent(values: typeof analyticsEventsTable.$inferInsert): Promise<void> {
  // A milestone already recorded for this profile is simply kept
  await db.insert(analyticsEventsTable).values(values).onConflictDoNothing();
}

/** Events and distinct profiles per event name over the last `days` days */
export async function countAnalyticsEvents(days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  return db
    .select({
      name: analyticsEventsTable.name,
      events: count(),
      profiles: countDistinct(analyticsEventsTable.profileId),
    })
    .from(analyticsEventsTable)
    .where(gte(analyticsEventsTable.createdAt, since))
    .groupBy(analyticsEventsTable.name);
}
