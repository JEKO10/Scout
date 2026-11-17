import "server-only";

import { lastGrowthRefreshAt, markPostsUnavailable, saveAccountSnapshot } from "@/db/queries/growth";
import { savePosts } from "@/db/queries/posts";
import { linkCsvSocialAccount, markSocialAccountSynced, upsertSocialAccount } from "@/db/queries/socialAccounts";
import type { Profile } from "@/db/schema";
import { getXUserPosts, getXUserWithCounts, XApiBudgetError, XApiRequestError, type XRequestStats } from "@/lib/x/client";
import { X_PRICING } from "@/lib/x/pricing";
import { track } from "@/services/analytics/track";
import { getUsageBudget } from "@/services/billing/budget";

// Day 33 Growth Intelligence data collection: only when the user asks, at
// most once a day, from the plan's existing X reads. No background
// collection: the budgets don't leave room for it (see the Day 33 report).

/** Your newest posts re-read per refresh: their metrics are still moving */
export const GROWTH_REFRESH_POSTS = 20;
export const GROWTH_REFRESH_MIN_HOURS = 20;
/** Estimated X cost of one refresh: 20 post reads + 1 profile read */
export const GROWTH_REFRESH_USD = GROWTH_REFRESH_POSTS * X_PRICING.postRead + X_PRICING.userRead;

export type GrowthRefreshResult = { ok: true; message: string } | { ok: false; message: string };

export async function refreshGrowthData(profile: Profile, now = new Date()): Promise<GrowthRefreshResult> {
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
