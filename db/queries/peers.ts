import "server-only";

import { and, count, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";

import db from "@/db";
import {
  type GrowthPeer,
  growthPeersTable,
  peerPostStatsTable,
  peerRefreshesTable,
  scoutCandidatesTable,
  watchlistAccountsTable,
  xPostsTable,
} from "@/db/schema";
import { hookType, lengthBucket } from "@/lib/growth/analyze";
import type { PeerStat } from "@/lib/strategy/peers";
import { PEER_STATS_RETENTION_DAYS } from "@/lib/strategy/types";

// Day 35 Peer Intelligence. Every query is scoped by profileId; peer
// observations come only from posts Scout already read through the X API
// (the shared x_posts cache), kept as derived numbers without text.

const DAY_MS = 86_400_000;

export async function listPeers(profileId: string): Promise<GrowthPeer[]> {
  return db.select().from(growthPeersTable).where(eq(growthPeersTable.profileId, profileId)).orderBy(desc(growthPeersTable.createdAt));
}

export async function getPeer(profileId: string, id: string): Promise<GrowthPeer | undefined> {
  const [row] = await db
    .select()
    .from(growthPeersTable)
    .where(and(eq(growthPeersTable.profileId, profileId), eq(growthPeersTable.id, id)))
    .limit(1);
  return row;
}

export async function countPeers(profileId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(growthPeersTable).where(eq(growthPeersTable.profileId, profileId));
  return row?.n ?? 0;
}

/** Peers added since a moment (a daily cap on lookups) */
export async function countPeersAddedSince(profileId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(growthPeersTable)
    .where(and(eq(growthPeersTable.profileId, profileId), gte(growthPeersTable.lookedUpAt, since)));
  return row?.n ?? 0;
}

export type PeerValues = Pick<
  GrowthPeer,
  "platformUserId" | "handle" | "displayName" | "bio" | "followers" | "following" | "postCount" | "accountCreatedAt" | "source" | "lookedUpAt"
>;

/** Adds a peer, or refreshes its public profile if it's already there */
export async function savePeer(profileId: string, values: PeerValues): Promise<GrowthPeer> {
  const [row] = await db
    .insert(growthPeersTable)
    .values({ profileId, ...values, selected: true })
    .onConflictDoUpdate({
      target: [growthPeersTable.profileId, growthPeersTable.platformUserId],
      set: {
        handle: values.handle,
        displayName: values.displayName,
        bio: values.bio,
        followers: values.followers,
        following: values.following,
        postCount: values.postCount,
        accountCreatedAt: values.accountCreatedAt,
        lookedUpAt: values.lookedUpAt,
      },
    })
    .returning();
  return row;
}

export async function deletePeer(profileId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(growthPeersTable)
    .where(and(eq(growthPeersTable.profileId, profileId), eq(growthPeersTable.id, id)))
    .returning({ id: growthPeersTable.id });
  return rows.length > 0;
}

export async function setPeerSelected(profileId: string, id: string, selected: boolean): Promise<boolean> {
  const rows = await db
    .update(growthPeersTable)
    .set({ selected })
    .where(and(eq(growthPeersTable.profileId, profileId), eq(growthPeersTable.id, id)))
    .returning({ id: growthPeersTable.id });
  return rows.length > 0;
}

/** Topic labels found in a post, case-insensitive whole words */
export function matchTopics(text: string, topics: string[]): string[] {
  const lower = text.toLowerCase();
  return topics.filter((topic) => {
    const t = topic.toLowerCase().trim();
    if (t.length < 3) return false;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(lower);
  });
}

/**
 * Copies what Scout already read for these peers (x_posts, from scans or a
 * peer refresh) into derived stats: no X call, no text kept. Metrics are
 * updated for posts seen again. Original posts and quotes only.
 */
export async function ingestPeerStats(peers: Pick<GrowthPeer, "id" | "platformUserId">[], topics: string[], now = new Date()): Promise<number> {
  if (peers.length === 0) return 0;
  const since = new Date(now.getTime() - PEER_STATS_RETENTION_DAYS * DAY_MS);
  const posts = await db
    .select()
    .from(xPostsTable)
    .where(
      and(
        inArray(
          xPostsTable.authorPlatformUserId,
          peers.map((p) => p.platformUserId),
        ),
        inArray(xPostsTable.kind, ["post", "quote"]),
        gte(xPostsTable.postedAt, since),
      ),
    );
  const rows = posts.flatMap((post) =>
    peers
      .filter((peer) => peer.platformUserId === post.authorPlatformUserId)
      .map((peer) => ({
        peerId: peer.id,
        platformPostId: post.platformPostId,
        postedAt: post.postedAt,
        lengthBucket: lengthBucket(post.content),
        hookType: hookType(post.content),
        topics: matchTopics(post.content, topics),
        likes: post.metrics?.likes ?? null,
        replies: post.metrics?.replies ?? null,
        reposts: post.metrics?.reposts ?? null,
        impressions: post.metrics?.impressions ?? null,
      })),
  );
  if (rows.length === 0) return 0;
  const t = peerPostStatsTable;
  await db
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.peerId, t.platformPostId],
      set: {
        likes: sql`coalesce(excluded."likes", ${t.likes})`,
        replies: sql`coalesce(excluded."replies", ${t.replies})`,
        reposts: sql`coalesce(excluded."reposts", ${t.reposts})`,
        impressions: sql`coalesce(excluded."impressions", ${t.impressions})`,
      },
    });
  return rows.length;
}

export async function getPeerStats(peerIds: string[], now = new Date()): Promise<Map<string, PeerStat[]>> {
  const map = new Map<string, PeerStat[]>();
  if (peerIds.length === 0) return map;
  const since = new Date(now.getTime() - PEER_STATS_RETENTION_DAYS * DAY_MS);
  const rows = await db
    .select()
    .from(peerPostStatsTable)
    .where(and(inArray(peerPostStatsTable.peerId, peerIds), gte(peerPostStatsTable.postedAt, since)));
  for (const row of rows) {
    map.set(row.peerId, [
      ...(map.get(row.peerId) ?? []),
      {
        postedAt: row.postedAt,
        lengthBucket: row.lengthBucket,
        hookType: row.hookType,
        topics: row.topics,
        likes: row.likes,
        replies: row.replies,
        reposts: row.reposts,
        impressions: row.impressions,
      },
    ]);
  }
  return map;
}

/**
 * Suggestions from data Scout already has, no X search: accounts on the
 * user's watchlist and authors that keep showing up in their scans. Shown
 * as suggestions until the user adds them.
 */
export async function getPeerSuggestions(profileId: string, exclude: string[], now = new Date()) {
  const [watched, frequent] = await Promise.all([
    db
      .select({ platformUserId: watchlistAccountsTable.platformUserId, handle: watchlistAccountsTable.handle })
      .from(watchlistAccountsTable)
      .where(
        and(
          eq(watchlistAccountsTable.profileId, profileId),
          exclude.length ? notInArray(watchlistAccountsTable.platformUserId, exclude) : undefined,
        ),
      )
      .limit(10),
    db
      .select({
        platformUserId: scoutCandidatesTable.authorPlatformUserId,
        handle: scoutCandidatesTable.authorHandle,
        n: count(),
      })
      .from(scoutCandidatesTable)
      .where(and(eq(scoutCandidatesTable.profileId, profileId), gte(scoutCandidatesTable.createdAt, new Date(now.getTime() - 30 * DAY_MS))))
      .groupBy(scoutCandidatesTable.authorPlatformUserId, scoutCandidatesTable.authorHandle)
      .having(sql`count(*) >= 3`)
      .orderBy(desc(count()))
      .limit(10),
  ]);
  const seen = new Set(exclude);
  const suggestions: { platformUserId: string; handle: string; source: "watchlist" | "scans"; reason: string }[] = [];
  for (const w of watched) {
    if (seen.has(w.platformUserId)) continue;
    seen.add(w.platformUserId);
    suggestions.push({ platformUserId: w.platformUserId, handle: w.handle, source: "watchlist", reason: "On your watchlist" });
  }
  for (const f of frequent) {
    if (!f.platformUserId || seen.has(f.platformUserId)) continue;
    seen.add(f.platformUserId);
    suggestions.push({ platformUserId: f.platformUserId, handle: f.handle, source: "scans", reason: `${f.n} of their posts appeared in your scans this month` });
  }
  return suggestions.slice(0, 8);
}

// ---- Peer refreshes (live X reads; off unless approved) ---------------------------------

export async function recordPeerRefresh(profileId: string, platformUserId: string, xPostReads: number, now = new Date()): Promise<void> {
  await db.insert(peerRefreshesTable).values({ profileId, platformUserId, xPostReads, createdAt: now });
}

/** X posts read by peer refreshes since a date: counted in the plan's X reads */
export async function sumPeerXPostReads(profileId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ reads: sql<number>`coalesce(sum(${peerRefreshesTable.xPostReads}), 0)::int` })
    .from(peerRefreshesTable)
    .where(and(eq(peerRefreshesTable.profileId, profileId), gte(peerRefreshesTable.createdAt, since)));
  return row?.reads ?? 0;
}

export async function countPeerRefreshesSince(profileId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(peerRefreshesTable)
    .where(and(eq(peerRefreshesTable.profileId, profileId), gte(peerRefreshesTable.createdAt, since)));
  return row?.n ?? 0;
}

export async function markPeerRefreshed(profileId: string, id: string, now = new Date()): Promise<void> {
  await db
    .update(growthPeersTable)
    .set({ lastRefreshedAt: now })
    .where(and(eq(growthPeersTable.profileId, profileId), eq(growthPeersTable.id, id)));
}

/** Retention: derived peer stats older than 90 days */
export async function deleteOldPeerStats(now = new Date()): Promise<number> {
  const rows = await db
    .delete(peerPostStatsTable)
    .where(lt(peerPostStatsTable.postedAt, new Date(now.getTime() - PEER_STATS_RETENTION_DAYS * DAY_MS)))
    .returning({ peerId: peerPostStatsTable.peerId });
  return rows.length;
}
