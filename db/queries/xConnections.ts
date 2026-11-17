import "server-only";

import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import db from "@/db";
import {
  type PostMetrics,
  postMetricSnapshotsTable,
  type PostPrivateMetrics,
  postsTable,
  profilesTable,
  type XConnection,
  xConnectionsTable,
} from "@/db/schema";
import type { PlanId } from "@/lib/billing/plans";

// X OAuth connections and the post metric history they collect. Only called
// when X OAuth is enabled (lib/x/oauth.ts isXOAuthEnabled), so a database
// without these tables keeps working while the feature is off.

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

export async function getXConnection(profileId: string): Promise<XConnection | undefined> {
  const [row] = await db.select().from(xConnectionsTable).where(eq(xConnectionsTable.profileId, profileId)).limit(1);
  return row;
}

/** Whether another Scout profile already connected this X account */
export async function xUserConnectedElsewhere(xUserId: string, profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: xConnectionsTable.id })
    .from(xConnectionsTable)
    .where(and(eq(xConnectionsTable.xUserId, xUserId), ne(xConnectionsTable.profileId, profileId)))
    .limit(1);
  return Boolean(row);
}

export type XConnectionInput = Pick<
  XConnection,
  | "socialAccountId"
  | "xUserId"
  | "handle"
  | "scopes"
  | "encryptedAccessToken"
  | "encryptedRefreshToken"
  | "accessTokenExpiresAt"
  | "nextCollectionAt"
>;

/** Connect or reconnect: one connection per profile, fresh tokens, active again */
export async function saveXConnection(profileId: string, input: XConnectionInput, now = new Date()): Promise<XConnection> {
  const [row] = await db
    .insert(xConnectionsTable)
    .values({ profileId, ...input, connectedAt: now })
    .onConflictDoUpdate({
      target: xConnectionsTable.profileId,
      set: { ...input, status: "active", lastError: null, connectedAt: now, busyUntil: null, updatedAt: now },
    })
    .returning();
  return row;
}

export async function updateXTokens(
  connectionId: string,
  tokens: Pick<XConnection, "encryptedAccessToken" | "encryptedRefreshToken" | "accessTokenExpiresAt">,
): Promise<void> {
  await db.update(xConnectionsTable).set(tokens).where(eq(xConnectionsTable.id, connectionId));
}

export async function markXConnectionNeedsReconnect(connectionId: string, error: string): Promise<void> {
  await db
    .update(xConnectionsTable)
    .set({ status: "needs_reconnect", lastError: error.slice(0, 500), busyUntil: null })
    .where(eq(xConnectionsTable.id, connectionId));
}

/**
 * Takes the connection for one refresh or collection. One atomic UPDATE:
 * two clicks, or a click and the scheduler, can't both read from X. A lock
 * left by a crashed worker expires after `minutes`.
 */
export async function claimXConnection(profileId: string, now = new Date(), minutes = 5): Promise<XConnection | undefined> {
  const [row] = await db
    .update(xConnectionsTable)
    .set({ busyUntil: new Date(now.getTime() + minutes * 60_000) })
    .where(
      and(
        eq(xConnectionsTable.profileId, profileId),
        eq(xConnectionsTable.status, "active"),
        or(isNull(xConnectionsTable.busyUntil), lt(xConnectionsTable.busyUntil, now)),
      ),
    )
    .returning();
  return row;
}

export async function releaseXConnection(
  connectionId: string,
  patch: Partial<Pick<XConnection, "lastCollectedAt" | "lastAutoCollectedAt" | "nextCollectionAt" | "lastError">> = {},
): Promise<void> {
  await db
    .update(xConnectionsTable)
    .set({ ...patch, busyUntil: null })
    .where(eq(xConnectionsTable.id, connectionId));
}

/** Postpones automatic collection, unless a collection already planned a later date */
export async function setNextCollectionAt(connectionId: string, at: Date, now = new Date()): Promise<void> {
  await db
    .update(xConnectionsTable)
    .set({ nextCollectionAt: at })
    .where(
      and(
        eq(xConnectionsTable.id, connectionId),
        isNotNull(xConnectionsTable.nextCollectionAt),
        lte(xConnectionsTable.nextCollectionAt, now),
      ),
    );
}

export async function deleteXConnection(profileId: string): Promise<XConnection | undefined> {
  const [row] = await db.delete(xConnectionsTable).where(eq(xConnectionsTable.profileId, profileId)).returning();
  return row;
}

/** Active connections due for automatic collection, on plans that have it */
export async function getDueXConnections(plans: PlanId[], now: Date, limit: number) {
  if (plans.length === 0) return [];
  return db
    .select({ connection: xConnectionsTable, plan: profilesTable.plan })
    .from(xConnectionsTable)
    .innerJoin(profilesTable, eq(profilesTable.id, xConnectionsTable.profileId))
    .where(
      and(
        eq(xConnectionsTable.status, "active"),
        isNotNull(xConnectionsTable.nextCollectionAt),
        lte(xConnectionsTable.nextCollectionAt, now),
        inArray(profilesTable.plan, plans),
      ),
    )
    .orderBy(asc(xConnectionsTable.nextCollectionAt))
    .limit(limit);
}

/** Automatic collections that started today (UTC), across all of Scout */
export async function countAutoCollectionsToday(now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(xConnectionsTable)
    .where(gte(xConnectionsTable.lastAutoCollectedAt, start));
  return row?.n ?? 0;
}

/** Today's reading of each post (a later reading the same day replaces it) */
export async function savePostMetricSnapshots(
  profileId: string,
  socialAccountId: string,
  readings: { platformPostId: string; publicMetrics: PostMetrics | undefined; privateMetrics: PostPrivateMetrics | null }[],
  now = new Date(),
): Promise<void> {
  if (readings.length === 0) return;
  const posts = await db
    .select({ id: postsTable.id, platformPostId: postsTable.platformPostId })
    .from(postsTable)
    .where(
      and(
        eq(postsTable.socialAccountId, socialAccountId),
        inArray(
          postsTable.platformPostId,
          readings.map((reading) => reading.platformPostId),
        ),
      ),
    );
  const idByPlatformId = new Map(posts.map((post) => [post.platformPostId, post.id]));
  const rows = readings.flatMap((reading) => {
    const postId = idByPlatformId.get(reading.platformPostId);
    return postId
      ? [{ profileId, postId, day: utcDay(now), capturedAt: now, source: "x_oauth" as const, publicMetrics: reading.publicMetrics ?? null, privateMetrics: reading.privateMetrics }]
      : [];
  });
  if (rows.length === 0) return;
  const t = postMetricSnapshotsTable;
  await db
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.postId, t.day],
      set: {
        capturedAt: now,
        publicMetrics: sql`excluded."publicMetrics"`,
        // A later reading without private metrics doesn't erase the earlier one
        privateMetrics: sql`coalesce(excluded."privateMetrics", ${t.privateMetrics})`,
      },
    });
}

/** Each post's latest private metrics (any day), for posts of one account */
export async function getLatestPrivateMetrics(
  socialAccountId: string,
  since: Date,
): Promise<Map<string, { metrics: PostPrivateMetrics; capturedAt: Date }>> {
  const rows = await db
    .selectDistinctOn([postMetricSnapshotsTable.postId], {
      postId: postMetricSnapshotsTable.postId,
      metrics: postMetricSnapshotsTable.privateMetrics,
      capturedAt: postMetricSnapshotsTable.capturedAt,
    })
    .from(postMetricSnapshotsTable)
    .innerJoin(postsTable, eq(postsTable.id, postMetricSnapshotsTable.postId))
    .where(
      and(
        eq(postsTable.socialAccountId, socialAccountId),
        gte(postsTable.publishedAt, since),
        isNotNull(postMetricSnapshotsTable.privateMetrics),
      ),
    )
    .orderBy(postMetricSnapshotsTable.postId, sql`${postMetricSnapshotsTable.capturedAt} desc`);
  return new Map(rows.map((row) => [row.postId, { metrics: row.metrics!, capturedAt: row.capturedAt }]));
}

/** Disconnect with "also delete": the private metrics Scout stored for this profile */
export async function deletePrivateMetricSnapshots(profileId: string): Promise<number> {
  const rows = await db
    .delete(postMetricSnapshotsTable)
    .where(eq(postMetricSnapshotsTable.profileId, profileId))
    .returning({ id: postMetricSnapshotsTable.id });
  return rows.length;
}
