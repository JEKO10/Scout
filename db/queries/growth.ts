import "server-only";

import { and, asc, desc, eq, gte, isNotNull, isNull, lt, min, or, sql } from "drizzle-orm";

import db from "@/db";
import {
  accountMetricSnapshotsTable,
  contentDraftsTable,
  opportunitiesTable,
  type Post,
  postsTable,
  repliesTable,
  replyIntentsTable,
  type SocialAccount,
  socialAccountsTable,
  trendsTable,
} from "@/db/schema";
import type { NormalizedProfileCounts } from "@/lib/posts/types";

// Day 33 Growth Intelligence. Every query is scoped by profileId (or by an
// account the caller looked up through the profile).

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Today's reading of the account's public counts. A later reading the same
 * day replaces the counts; refresh reads add up (they are billed).
 */
export async function saveAccountSnapshot(
  profileId: string,
  socialAccountId: string,
  counts: NormalizedProfileCounts,
  { xPostReads = 0, refreshed = false, now = new Date() }: { xPostReads?: number; refreshed?: boolean; now?: Date } = {},
): Promise<void> {
  const t = accountMetricSnapshotsTable;
  await db
    .insert(t)
    .values({
      profileId,
      socialAccountId,
      platform: "x",
      day: utcDay(now),
      capturedAt: now,
      ...counts,
      xPostReads,
      refreshedAt: refreshed ? now : null,
    })
    .onConflictDoUpdate({
      target: [t.socialAccountId, t.day],
      set: {
        capturedAt: now,
        followers: sql`coalesce(excluded."followers", ${t.followers})`,
        following: sql`coalesce(excluded."following", ${t.following})`,
        postCount: sql`coalesce(excluded."postCount", ${t.postCount})`,
        xPostReads: sql`${t.xPostReads} + excluded."xPostReads"`,
        refreshedAt: sql`coalesce(excluded."refreshedAt", ${t.refreshedAt})`,
      },
    });
}

/** The profile's X account: the one matching its handle, else the latest synced */
export async function getGrowthAccount(profileId: string, handle: string | null): Promise<SocialAccount | undefined> {
  const rows = await db
    .select()
    .from(socialAccountsTable)
    .where(and(eq(socialAccountsTable.profileId, profileId), eq(socialAccountsTable.platform, "x")))
    .orderBy(desc(socialAccountsTable.lastSyncedAt));
  return rows.find((row) => handle && row.handle.toLowerCase() === handle.toLowerCase()) ?? rows[0];
}

/** Posts still on X, published since `since`, oldest first */
export async function getGrowthPosts(socialAccountId: string, since: Date): Promise<Post[]> {
  return db
    .select()
    .from(postsTable)
    .where(
      and(
        eq(postsTable.socialAccountId, socialAccountId),
        gte(postsTable.publishedAt, since),
        isNull(postsTable.unavailableAt),
      ),
    )
    .orderBy(asc(postsTable.publishedAt));
}

/** The oldest post Scout holds: before it, Scout doesn't know what was posted */
export async function getOldestPostAt(socialAccountId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: min(postsTable.publishedAt) })
    .from(postsTable)
    .where(eq(postsTable.socialAccountId, socialAccountId));
  return row?.at ? new Date(row.at) : null;
}

export async function getAccountSnapshots(socialAccountId: string, since: Date) {
  return db
    .select()
    .from(accountMetricSnapshotsTable)
    .where(and(eq(accountMetricSnapshotsTable.socialAccountId, socialAccountId), gte(accountMetricSnapshotsTable.day, utcDay(since))))
    .orderBy(asc(accountMetricSnapshotsTable.day));
}

/** The latest snapshot on or before a day: the baseline for "net change" */
export async function getSnapshotBefore(socialAccountId: string, day: Date) {
  const [row] = await db
    .select()
    .from(accountMetricSnapshotsTable)
    .where(
      and(
        eq(accountMetricSnapshotsTable.socialAccountId, socialAccountId),
        lt(accountMetricSnapshotsTable.day, utcDay(day)),
        isNotNull(accountMetricSnapshotsTable.followers),
      ),
    )
    .orderBy(desc(accountMetricSnapshotsTable.day))
    .limit(1);
  return row;
}

export async function lastGrowthRefreshAt(profileId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${accountMetricSnapshotsTable.refreshedAt})` })
    .from(accountMetricSnapshotsTable)
    .where(eq(accountMetricSnapshotsTable.profileId, profileId));
  return row?.at ? new Date(row.at) : null;
}

/** X posts read by Growth refreshes since a date: counted in the plan's X reads */
export async function sumGrowthXPostReads(profileId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ reads: sql<number>`coalesce(sum(${accountMetricSnapshotsTable.xPostReads}), 0)::int` })
    .from(accountMetricSnapshotsTable)
    .where(and(eq(accountMetricSnapshotsTable.profileId, profileId), gte(accountMetricSnapshotsTable.day, utcDay(since))));
  return row?.reads ?? 0;
}

/** Stored posts X didn't return in a window it fully covered: deleted or hidden */
export async function markPostsUnavailable(socialAccountId: string, from: Date, keepIds: string[], now = new Date()): Promise<number> {
  const rows = await db
    .update(postsTable)
    // Day 40.1: X no longer returns it (deleted or hidden): its text isn't kept. A later
    // refresh that finds it again restores it (savePosts clears unavailableAt).
    .set({ unavailableAt: now, content: "" })
    .where(
      and(
        eq(postsTable.socialAccountId, socialAccountId),
        gte(postsTable.publishedAt, from),
        isNull(postsTable.unavailableAt),
        keepIds.length > 0 ? sql`${postsTable.platformPostId} not in (${sql.join(keepIds.map((id) => sql`${id}`), sql`, `)})` : undefined,
      ),
    )
    .returning({ id: postsTable.id });
  return rows.length;
}

/** Studio drafts the user says they posted (with or without a link) */
export async function getPublishedDrafts(profileId: string) {
  return db
    .select({
      id: contentDraftsTable.id,
      title: contentDraftsTable.title,
      goal: contentDraftsTable.goal,
      format: contentDraftsTable.format,
      topic: contentDraftsTable.topic,
      trendLabel: trendsTable.label,
      sourceTrendId: contentDraftsTable.sourceTrendId,
      publishedUrl: contentDraftsTable.publishedUrl,
      publishedConfirmedAt: contentDraftsTable.publishedConfirmedAt,
    })
    .from(contentDraftsTable)
    .leftJoin(trendsTable, eq(trendsTable.id, contentDraftsTable.sourceTrendId))
    .where(
      and(
        eq(contentDraftsTable.profileId, profileId),
        or(isNotNull(contentDraftsTable.publishedConfirmedAt), isNotNull(contentDraftsTable.publishedUrl)),
      ),
    );
}

/** Opportunity Scout activity in a period, from what Scout itself recorded */
export async function getReplyActivityCounts(profileId: string, since: Date) {
  const [opportunities, generated, intents] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(opportunitiesTable)
      .where(and(eq(opportunitiesTable.profileId, profileId), gte(opportunitiesTable.createdAt, since))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(repliesTable)
      .innerJoin(opportunitiesTable, eq(opportunitiesTable.id, repliesTable.opportunityId))
      .where(and(eq(opportunitiesTable.profileId, profileId), gte(repliesTable.createdAt, since))),
    db
      .select({ platformPostId: replyIntentsTable.platformPostId, status: replyIntentsTable.status })
      .from(replyIntentsTable)
      .where(and(eq(replyIntentsTable.profileId, profileId), gte(replyIntentsTable.openedAt, since))),
  ]);
  return {
    opportunities: opportunities[0]?.n ?? 0,
    generated: generated[0]?.n ?? 0,
    opened: intents.filter((row) => row.status !== "returned").length,
    confirmed: intents.filter((row) => row.status === "confirmed").length,
    /** Posts the user opened a Scout reply for: to match against their own replies */
    repliedToPostIds: intents.filter((row) => row.status !== "returned").map((row) => row.platformPostId),
  };
}

/** For tests and the account page: snapshots of several accounts */
export async function getSnapshotsForProfile(profileId: string) {
  return db
    .select()
    .from(accountMetricSnapshotsTable)
    .where(eq(accountMetricSnapshotsTable.profileId, profileId))
    .orderBy(asc(accountMetricSnapshotsTable.day));
}

