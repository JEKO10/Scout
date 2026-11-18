import "server-only";

import {
  countPeerRefreshesSince,
  countPeers,
  countPeersAddedSince,
  getPeer,
  getPeerStats,
  ingestPeerStats,
  listPeers,
  markPeerRefreshed,
  recordPeerRefresh,
  savePeer,
} from "@/db/queries/peers";
import type { GrowthPeer, Profile } from "@/db/schema";
import { effectiveLimits } from "@/lib/billing/plans";
import { keywords, peerEvidence, type PeerFinding, peerFindings, type PeerScore, type PeerStat, scorePeer } from "@/lib/strategy/peers";
import type { EvidenceItem } from "@/lib/strategy/types";
import { MAX_PEERS_PER_STRATEGY, PEER_MIN_POSTS, type PeerMode } from "@/lib/strategy/types";
import { getXPeerProfile, XApiBudgetError, XApiRequestError } from "@/lib/x/client";
import { currentPeriodStart, getUsageBudget } from "@/services/billing/budget";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { ensureFreshPosts } from "@/services/x/sharedFetch";

// Day 35 Peer Intelligence: peers the user saves, their comparability, and
// observations from posts Scout already read through the X API. Adding a
// peer costs one X user read; analysis costs nothing (stored data only);
// live refreshes are off unless PEER_REFRESH_ENABLED is approved.

/** Peer lookups per day per user: each is a billed X user read */
export const MAX_PEER_ADDS_PER_DAY = 5;
/** A refreshed peer isn't read from X again for this long */
export const PEER_REFRESH_CACHE_DAYS = 7;
/** Posts read per peer refresh */
export const PEER_REFRESH_POSTS = 20;

const DAY_MS = 86_400_000;

export function isPeerRefreshEnabled(): boolean {
  return process.env.PEER_REFRESH_ENABLED === "true";
}

/** Words describing the user, for topic similarity with a peer's bio */
export function userKeywords(profile: Profile): Set<string> {
  const brain = resolveScoutBrain(profile);
  return keywords(
    profile.occupation,
    profile.targetAudience,
    profile.knownFor,
    profile.topics,
    brain?.interests.topics.map((t) => t.label).join(" "),
    brain?.goals.knownFor.map((k) => k.label).join(" "),
    brain?.goals.targetAudience.map((a) => a.label).join(" "),
    profile.leadProfile?.product,
    profile.leadProfile?.problems.join(" "),
    profile.leadProfile?.industries.join(" "),
  );
}

/** The user's topic labels, matched in peer posts */
export function userTopics(profile: Profile): string[] {
  const brain = resolveScoutBrain(profile);
  const labels = brain?.interests.topics.map((t) => t.label) ?? (profile.topics ?? "").split(/[,\n]/);
  return labels.map((label) => label.trim()).filter((label) => label.length >= 3).slice(0, 15);
}

export type AddPeerResult = { ok: true; peer: GrowthPeer } | { ok: false; message: string };

/**
 * Adds an account to compare with: one X user read for its public profile
 * (counts, bio, creation date), within the plan's peer limit and a daily
 * cap on lookups. The account must exist on X: nothing is invented.
 */
export async function addPeer(
  profile: Profile,
  handle: string,
  source: GrowthPeer["source"] = "manual",
  now = new Date(),
): Promise<AddPeerResult> {
  const limit = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxSavedPeers;
  if ((await countPeers(profile.id)) >= limit) {
    return { ok: false, message: `Your plan can compare with ${limit} accounts. Remove one to add another.` };
  }
  if ((await countPeersAddedSince(profile.id, new Date(now.getTime() - DAY_MS))) >= MAX_PEER_ADDS_PER_DAY) {
    return { ok: false, message: `You can add up to ${MAX_PEER_ADDS_PER_DAY} accounts a day.` };
  }
  if (profile.xHandle && profile.xHandle.toLowerCase() === handle.toLowerCase()) {
    return { ok: false, message: "That's your own account. Add accounts you want to learn from." };
  }
  let found: Awaited<ReturnType<typeof getXPeerProfile>>;
  try {
    found = await getXPeerProfile(handle);
  } catch (error) {
    if (error instanceof XApiBudgetError) return { ok: false, message: "Scout's daily X limit is reached. Try again tomorrow." };
    if (error instanceof XApiRequestError) return { ok: false, message: error.status === 429 ? "X is rate limiting requests. Try again later." : "Couldn't reach X. Try again later." };
    throw error;
  }
  if (!found) return { ok: false, message: `X didn't find @${handle}.` };
  const peer = await savePeer(profile.id, {
    platformUserId: found.profile.platformUserId,
    handle: found.profile.handle,
    displayName: found.profile.displayName,
    bio: found.bio,
    followers: found.counts.followers,
    following: found.counts.following,
    postCount: found.counts.postCount,
    accountCreatedAt: found.createdAt,
    source,
    lookedUpAt: now,
  });
  await ingestPeerStats([peer], userTopics(profile), now);
  return { ok: true, peer };
}

export type RefreshPeerResult = { ok: boolean; message: string };

/**
 * A live read of a peer's recent posts (up to 20), paid from the plan's
 * monthly X reads. Off unless PEER_REFRESH_ENABLED=true (pending approval),
 * at most once a week per peer, within the plan's monthly refresh count.
 * Peers on the watchlist don't need it: scans already read them.
 */
export async function refreshPeer(profile: Profile, peerId: string, now = new Date()): Promise<RefreshPeerResult> {
  if (!isPeerRefreshEnabled()) return { ok: false, message: "Live peer refreshes aren't enabled yet. Scout uses posts it already read in your scans." };
  const peer = await getPeer(profile.id, peerId);
  if (!peer) return { ok: false, message: "Account not found." };
  if (peer.lastRefreshedAt && now.getTime() - peer.lastRefreshedAt.getTime() < PEER_REFRESH_CACHE_DAYS * DAY_MS) {
    return { ok: false, message: `Read from X ${Math.floor((now.getTime() - peer.lastRefreshedAt.getTime()) / DAY_MS)} days ago; Scout reuses it for ${PEER_REFRESH_CACHE_DAYS} days.` };
  }
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  if ((await countPeerRefreshesSince(profile.id, currentPeriodStart(now))) >= limits.maxPeerRefreshesPerMonth) {
    return { ok: false, message: `Your plan includes ${limits.maxPeerRefreshesPerMonth} peer refreshes a month.` };
  }
  if ((await getUsageBudget(profile, now)).remaining.xPostReads < PEER_REFRESH_POSTS) {
    return { ok: false, message: "Not enough X reads left on your plan right now (scans use the same allowance)." };
  }
  const usage = { requests: 0, failed: 0, retried: 0, postsReturned: 0 };
  try {
    await ensureFreshPosts(
      { platformUserId: peer.platformUserId, handle: peer.handle },
      { firstLimit: PEER_REFRESH_POSTS, nextLimit: PEER_REFRESH_POSTS, notBefore: new Date(now.getTime() - 14 * DAY_MS), usage },
    );
  } catch (error) {
    if (error instanceof XApiBudgetError) return { ok: false, message: "Scout's daily X limit is reached. Try again tomorrow." };
    if (error instanceof XApiRequestError) return { ok: false, message: "Couldn't reach X. Try again later." };
    throw error;
  } finally {
    // Billed reads are counted even if a later step fails
    if (usage.requests > 0) await recordPeerRefresh(profile.id, peer.platformUserId, usage.postsReturned, now);
  }
  await markPeerRefreshed(profile.id, peer.id, now);
  await ingestPeerStats([peer], userTopics(profile), now);
  return { ok: true, message: `Read ${usage.postsReturned} recent posts from @${peer.handle}.` };
}

export type ScoredPeer = {
  peer: GrowthPeer;
  score: PeerScore;
  stats: PeerStat[];
  findings: PeerFinding[];
  /** Enough verified posts for patterns */
  sufficient: boolean;
  lastPostAt: Date | null;
};

/**
 * All saved peers with comparability, stored observations and patterns.
 * Reads the database only (posts Scout already has are copied into stats first).
 */
export async function loadPeers(profile: Profile, userFollowers: number | null, now = new Date()): Promise<ScoredPeer[]> {
  const peers = await listPeers(profile.id);
  if (peers.length === 0) return [];
  const topics = userTopics(profile);
  await ingestPeerStats(peers, topics, now);
  const statsByPeer = await getPeerStats(
    peers.map((p) => p.id),
    now,
  );
  const words = userKeywords(profile);
  return peers.map((peer) => {
    const stats = statsByPeer.get(peer.id) ?? [];
    const recent = stats.filter((s) => now.getTime() - s.postedAt.getTime() <= 30 * DAY_MS).length;
    const times = stats.map((s) => s.postedAt.getTime());
    return {
      peer,
      score: scorePeer(peer, {
        userFollowers,
        userKeywords: words,
        peerTopicPosts: stats.filter((s) => s.topics.length > 0).length,
        postsLast30: stats.length ? recent : null,
        now,
      }),
      stats,
      findings: peerFindings(stats),
      sufficient: stats.length >= PEER_MIN_POSTS,
      lastPostAt: times.length ? new Date(Math.max(...times)) : null,
    };
  });
}

/**
 * Which peers a strategy uses. recommended: Scout's most comparable saved
 * peers (direct first, then by relevance). selected: exactly the user's
 * selected accounts, never replaced, even without data.
 */
export function peersForStrategy(peers: ScoredPeer[], mode: PeerMode): ScoredPeer[] {
  if (mode === "selected") return peers.filter((p) => p.peer.selected).slice(0, MAX_PEERS_PER_STRATEGY);
  const rank = { direct: 0, unknown: 1, aspirational: 2 } as const;
  return [...peers]
    .sort((a, b) => rank[a.score.category] - rank[b.score.category] || b.score.score - a.score.score)
    .slice(0, MAX_PEERS_PER_STRATEGY);
}

/** Peer evidence and honest notes about what's missing, for one strategy */
export function strategyPeerEvidence(peers: ScoredPeer[], mode: PeerMode) {
  const used = peersForStrategy(peers, mode);
  const items: Omit<EvidenceItem, "id">[] = peerEvidence(
    used.map((p) => ({ handle: p.peer.handle, category: p.score.category, findings: p.findings, postsAnalyzed: p.stats.length })),
  );
  const missing: string[] = [];
  if (peers.length === 0) {
    missing.push("No peer accounts yet: add accounts you'd like to learn from, and Scout can compare what works for them.");
  } else if (used.length === 0) {
    missing.push("No accounts are selected: select the accounts to learn from, or switch to Scout recommended.");
  } else {
    const thin = used.filter((p) => !p.sufficient);
    if (thin.length) {
      missing.push(
        `Not enough verified posts yet from ${thin.map((p) => `@${p.peer.handle} (${p.stats.length})`).join(", ")}: Scout needs ${PEER_MIN_POSTS}+ posts per account it has read through X. Add them to your watchlist so scans read them${isPeerRefreshEnabled() ? ", or refresh them" : ""}.`,
      );
    }
    if (used.some((p) => p.sufficient) && items.length === 0) {
      missing.push("Your peers' posts show no clear pattern yet (5+ posts per group and a 25%+ difference within the same account).");
    }
    if (used.some((p) => p.score.category === "unknown")) missing.push("Some peers' follower counts are unknown: their comparability can't be judged.");
  }
  return { items, missing, used };
}
