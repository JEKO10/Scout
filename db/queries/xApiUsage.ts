import "server-only";

import { eq, sql } from "drizzle-orm";

import db from "@/db";
import { type XApiUsage, xApiUsageTable } from "@/db/schema";

// The database's UTC day, so every server instance shares the same counter
const today = sql`(now() at time zone 'utc')::date`;

/**
 * Reserves one request in today's budget before it is sent. Returns false when
 * the budget is used up. One atomic statement: concurrent runs can't both take
 * the last request. A null limit only counts.
 */
export async function reserveXRequest(
  limit: number | null,
  { retry }: { retry: boolean },
): Promise<boolean> {
  const retried = retry ? 1 : 0;
  const rows = await db
    .insert(xApiUsageTable)
    .values({ day: today, requests: 1, retriedRequests: retried })
    .onConflictDoUpdate({
      target: xApiUsageTable.day,
      set: {
        requests: sql`${xApiUsageTable.requests} + 1`,
        retriedRequests: sql`${xApiUsageTable.retriedRequests} + ${retried}`,
        updatedAt: new Date(),
      },
      setWhere:
        limit === null ? undefined : sql`${xApiUsageTable.requests} < ${limit}`,
    })
    .returning({ requests: xApiUsageTable.requests });
  // A first-of-the-day insert is never blocked, unless the limit is 0
  return rows.length > 0 && (limit === null || rows[0].requests <= limit);
}

type UsageCounter =
  "failedRequests" | "postsReturned" | "postsAccepted" | "runsCompleted";

/** Adds to today's counters, e.g. { failedRequests: 1 }. */
export async function recordXUsage(
  delta: Partial<Record<UsageCounter, number>>,
): Promise<void> {
  const entries = Object.entries(delta).filter(([, value]) => value) as [
    UsageCounter,
    number,
  ][];
  if (entries.length === 0) return;

  await db
    .insert(xApiUsageTable)
    .values({ day: today, ...Object.fromEntries(entries) })
    .onConflictDoUpdate({
      target: xApiUsageTable.day,
      set: {
        ...Object.fromEntries(
          entries.map(([key, value]) => [
            key,
            sql`${xApiUsageTable[key]} + ${value}`,
          ]),
        ),
        updatedAt: new Date(),
      },
    });
}

export async function getXUsageToday(): Promise<XApiUsage | undefined> {
  const [row] = await db
    .select()
    .from(xApiUsageTable)
    .where(eq(xApiUsageTable.day, today));
  return row;
}
