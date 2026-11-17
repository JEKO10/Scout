import "server-only";

import { lastGrowthRefreshAt, markPostsUnavailable, saveAccountSnapshot } from "@/db/queries/growth";
import { savePosts } from "@/db/queries/posts";
import { getProfileById } from "@/db/queries/profiles";
import { linkCsvSocialAccount, markSocialAccountSynced, upsertSocialAccount } from "@/db/queries/socialAccounts";
import {
  claimXConnection,
  countAutoCollectionsToday,
  getDueXConnections,
  getXConnection,
  releaseXConnection,
  savePostMetricSnapshots,
  setNextCollectionAt,
} from "@/db/queries/xConnections";
import type { Profile } from "@/db/schema";
import { PLAN_IDS, PLANS } from "@/lib/billing/plans";
import {
  getOwnPostsWithPrivateMetrics,
  getXAuthenticatedUser,
  getXUserPosts,
  getXUserWithCounts,
  XApiBudgetError,
  XApiRequestError,
  type XRequestStats,
} from "@/lib/x/client";
import { isXOAuthEnabled } from "@/lib/x/oauth";
import { X_PRICING } from "@/lib/x/pricing";
import { track } from "@/services/analytics/track";
import { getUsageBudget } from "@/services/billing/budget";
import { flagIfUnauthorized, getXAccessToken, nextAutoCollectionAt, XReconnectRequiredError } from "@/services/x/oauthConnection";

// Growth Intelligence data collection, always from the plan's existing X
// reads. Day 33: public metrics, only when the user asks, at most once a day.
// With X connected (OAuth): the same refresh also reads private metrics, and
// Starter/Pro can collect on their own (off until X_ANALYTICS_AUTO_ENABLED).

/** Your newest posts re-read per refresh: their metrics are still moving */
export const GROWTH_REFRESH_POSTS = 20;
export const GROWTH_REFRESH_MIN_HOURS = 20;
/** Estimated X cost of one refresh: 20 post reads + 1 profile read */
export const GROWTH_REFRESH_USD = GROWTH_REFRESH_POSTS * X_PRICING.postRead + X_PRICING.userRead;

export type GrowthRefreshResult = { ok: true; message: string } | { ok: false; message: string };

export async function refreshGrowthData(profile: Profile, now = new Date()): Promise<GrowthRefreshResult> {
  if (isXOAuthEnabled()) {
    const connection = await getXConnection(profile.id);
    if (connection?.status === "active") return collectConnectedGrowthData(profile, "manual", now);
    if (connection) return { ok: false, message: "Scout lost access to your X account. Reconnect X in Settings." };
  }
  if (!profile.xHandle) return { ok: false, message: "Add your X handle in Settings first." };

  const last = await lastGrowthRefreshAt(profile.id);
  if (last && now.getTime() - last.getTime() < GROWTH_REFRESH_MIN_HOURS * 3_600_000) {
    const hours = Math.ceil(GROWTH_REFRESH_MIN_HOURS - (now.getTime() - last.getTime()) / 3_600_000);
    return { ok: false, message: `Refreshed recently. You can refresh again in about ${hours} h.` };
  }
  const budget = await getUsageBudget(profile, now);
  if (budget.remaining.xPostReads < GROWTH_REFRESH_POSTS) {
    return {
      ok: false,
      message: `A refresh reads up to ${GROWTH_REFRESH_POSTS} posts from X; your plan has ${budget.remaining.xPostReads} X reads left right now (scans use the same allowance).`,
    };
  }

  const stats: XRequestStats = { requests: 0, failed: 0, retried: 0, postsReturned: 0 };
  let accountId: string | null = null;
  let counts = { followers: null as number | null, following: null as number | null, postCount: null as number | null };
  try {
    const found = await getXUserWithCounts(profile.xHandle);
    if (!found) return { ok: false, message: `X didn't find @${profile.xHandle}. Check the handle in Settings.` };
    counts = found.counts;
    await linkCsvSocialAccount(profile.id, "x", found.profile);
    const account = await upsertSocialAccount(profile.id, "x", found.profile);
    accountId = account.id;

    const posts = await getXUserPosts(found.profile.platformUserId, found.profile.handle, { limit: GROWTH_REFRESH_POSTS }, stats);
    await savePosts(account.id, posts);
    // X returned every post since the oldest one on this page: anything else
    // Scout holds from that window was deleted or hidden
    let unavailable = 0;
    if (posts.length > 0) {
      const oldest = new Date(Math.min(...posts.map((post) => post.publishedAt.getTime())));
      unavailable = await markPostsUnavailable(account.id, oldest, posts.map((post) => post.platformPostId), now);
    }
    await markSocialAccountSynced(account.id);
    await track("growth_refreshed", { profileId: profile.id });
    return {
      ok: true,
      message: `Updated ${posts.length} recent posts${counts.followers !== null ? " and your follower count" : ""}.${unavailable ? ` ${unavailable} no longer on X.` : ""}`,
    };
  } catch (error) {
    if (error instanceof XApiBudgetError) return { ok: false, message: "Scout's daily X limit is reached. Try again tomorrow." };
    if (error instanceof XApiRequestError) {
      return { ok: false, message: error.status === 429 ? "X is rate limiting requests. Try again later." : "Couldn't reach X. Try again later." };
    }
    throw error;
  } finally {
    // Reads are billed even when a later step fails: always counted
    if (accountId) await saveAccountSnapshot(profile.id, accountId, counts, { xPostReads: stats.postsReturned, refreshed: true, now });
  }
}

// ---- X connected (OAuth): private metrics -----------------------------------

/**
 * X has private metrics only for posts from the last 30 days; asking from 29
 * days back keeps every requested post inside that window, whatever X's clock.
 */
export const PRIVATE_METRICS_WINDOW_DAYS = 29;
/** An automatic collection leaves at least this many X reads for scans */
export const AUTO_COLLECTION_RESERVE_READS = GROWTH_REFRESH_POSTS;

/** Global cap on automatic collections per UTC day; 0 (the default) means none */
export function autoCollectionDailyCap(): number {
  if (process.env.X_ANALYTICS_AUTO_ENABLED !== "true") return 0;
  const cap = Number(process.env.X_ANALYTICS_AUTO_MAX_PER_DAY ?? 0);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
}

/**
 * One collection for a connected account: the profile through the user's
 * own token (ownership checked again, follower count), then their posts of
 * the last 29 days with private metrics. Same cost and spacing as a public
 * refresh: up to 20 post reads + 1 user read, at most once per 20 hours,
 * manual or automatic (they share the spacing, so they never both read).
 */
export async function collectConnectedGrowthData(
  profile: Profile,
  trigger: "manual" | "auto",
  now = new Date(),
): Promise<GrowthRefreshResult> {
  const last = await lastGrowthRefreshAt(profile.id);
  if (last && now.getTime() - last.getTime() < GROWTH_REFRESH_MIN_HOURS * 3_600_000) {
    const hours = Math.ceil(GROWTH_REFRESH_MIN_HOURS - (now.getTime() - last.getTime()) / 3_600_000);
    return { ok: false, message: `Refreshed recently. You can refresh again in about ${hours} h.` };
  }
  const budget = await getUsageBudget(profile, now);
  const needed = GROWTH_REFRESH_POSTS + (trigger === "auto" ? AUTO_COLLECTION_RESERVE_READS : 0);
  if (budget.remaining.xPostReads < needed) {
    return {
      ok: false,
      message: `A refresh reads up to ${GROWTH_REFRESH_POSTS} posts from X; your plan has ${budget.remaining.xPostReads} X reads left right now (scans use the same allowance).`,
    };
  }

  const connection = await claimXConnection(profile.id, now);
  if (!connection) return { ok: false, message: "A refresh is already running, or X needs to be reconnected." };

  const stats: XRequestStats = { requests: 0, failed: 0, retried: 0, postsReturned: 0 };
  let counts = { followers: null as number | null, following: null as number | null, postCount: null as number | null };
  let accountId = connection.socialAccountId;
  let collected = false;
  try {
    const token = await getXAccessToken(connection, now);
    const me = await getXAuthenticatedUser(token);
    stats.requests++;
    if (!me || me.profile.platformUserId !== connection.xUserId) {
      return { ok: false, message: "X returned a different account for this connection. Reconnect X in Settings." };
    }
    counts = me.counts;
    const account = await upsertSocialAccount(profile.id, "x", me.profile);
    accountId = account.id;

    const startTime = new Date(now.getTime() - PRIVATE_METRICS_WINDOW_DAYS * 86_400_000);
    const readings = await getOwnPostsWithPrivateMetrics(
      token,
      { platformUserId: connection.xUserId, handle: me.profile.handle },
      { limit: GROWTH_REFRESH_POSTS, startTime },
      stats,
    );
    const posts = readings.map((reading) => reading.post);
    await savePosts(account.id, posts);
    await savePostMetricSnapshots(
      profile.id,
      account.id,
      readings.map((reading) => ({
        platformPostId: reading.post.platformPostId,
        publicMetrics: reading.post.metrics,
        privateMetrics: reading.privateMetrics,
      })),
      now,
    );
    let unavailable = 0;
    if (posts.length > 0) {
      const oldest = new Date(Math.min(...posts.map((post) => post.publishedAt.getTime())));
      unavailable = await markPostsUnavailable(account.id, oldest, posts.map((post) => post.platformPostId), now);
    }
    await markSocialAccountSynced(account.id);
    await track("growth_refreshed", { profileId: profile.id });
    collected = true;
    const withPrivate = readings.filter((reading) => reading.privateMetrics).length;
    return {
      ok: true,
      message: `Updated ${posts.length} posts from the last ${PRIVATE_METRICS_WINDOW_DAYS} days (${withPrivate} with private metrics)${counts.followers !== null ? " and your follower count" : ""}.${unavailable ? ` ${unavailable} no longer on X.` : ""}`,
    };
  } catch (error) {
    if (error instanceof XReconnectRequiredError || (await flagIfUnauthorized(connection, error))) {
      return { ok: false, message: "Scout lost access to your X account. Reconnect X in Settings." };
    }
    if (error instanceof XApiBudgetError) return { ok: false, message: "Scout's daily X limit is reached. Try again tomorrow." };
    if (error instanceof XApiRequestError) {
      return { ok: false, message: error.status === 429 ? "X is rate limiting requests. Try again later." : "Couldn't reach X. Try again later." };
    }
    throw error;
  } finally {
    // Reads are billed even when a later step fails: always counted. The
    // snapshot's refreshedAt also spaces the next refresh, manual or automatic.
    if (stats.requests > 0) {
      await saveAccountSnapshot(profile.id, accountId, counts, { xPostReads: stats.postsReturned, refreshed: true, now });
    }
    await releaseXConnection(connection.id, {
      ...(collected && { lastCollectedAt: now }),
      ...(trigger === "auto" && { lastAutoCollectedAt: now }),
      // Any collection restarts the cadence: a manual refresh replaces the next automatic one
      ...(stats.requests > 0 && { nextCollectionAt: nextAutoCollectionAt(profile.plan, now) }),
    });
  }
}

export type AutoCollectionOutcome = { profileId: string; status: "collected" | "skipped" | "failed"; reason?: string };

/**
 * Scheduler step: automatic collection for Starter and Pro (plans with a
 * cadence), only when X_ANALYTICS_AUTO_ENABLED=true and under the global
 * daily cap. A skip moves the next attempt a day on instead of retrying
 * every tick.
 */
export async function runDueGrowthCollections({ limit = 5, now = new Date() }: { limit?: number; now?: Date } = {}): Promise<AutoCollectionOutcome[]> {
  if (!isXOAuthEnabled()) return [];
  const cap = autoCollectionDailyCap();
  if (cap === 0) return [];
  const plans = PLAN_IDS.filter((plan) => PLANS[plan].growthCollection.autoEveryHours !== null);
  const room = cap - (await countAutoCollectionsToday(now));
  if (room <= 0) return [];

  const outcomes: AutoCollectionOutcome[] = [];
  const tomorrow = new Date(now.getTime() + 24 * 3_600_000);
  for (const { connection } of await getDueXConnections(plans, now, Math.min(limit, room))) {
    const profile = await getProfileById(connection.profileId);
    if (!profile) continue;
    try {
      const result = await collectConnectedGrowthData(profile, "auto", now);
      if (result.ok) {
        outcomes.push({ profileId: profile.id, status: "collected" });
        continue;
      }
      outcomes.push({ profileId: profile.id, status: "skipped", reason: result.message });
    } catch (error) {
      outcomes.push({ profileId: profile.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
    // Only moves the date; never touches a lock another worker may hold
    await setNextCollectionAt(connection.id, tomorrow, now);
  }
  return outcomes;
}
