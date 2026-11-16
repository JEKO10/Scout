import "server-only";

import { getActiveDiscoveryTopics, markTopicSearched } from "@/db/queries/discovery";
import { getProfileById } from "@/db/queries/profiles";
import { getSeenPlatformPostIds, saveCandidates } from "@/db/queries/scoutCandidates";
import {
  failStaleScoutRuns,
  finishScoutRun,
  getActiveScoutRun,
  getRunGate,
  type RunGate,
  startScoutRun,
} from "@/db/queries/scoutRuns";
import {
  getActiveWatchlist,
  markWatchlistAccountsScanned,
  verifyWatchlistAccount,
} from "@/db/queries/watchlist";
import { recordXUsage } from "@/db/queries/xApiUsage";
import { getUndeliveredCachedPosts } from "@/db/queries/xCache";
import type { DiscoveryTopic, Profile, ScoutRun, WatchlistAccount, XPost } from "@/db/schema";
import { effectiveLimits } from "@/lib/billing/plans";
import { buildSearchQuery, languageCode } from "@/lib/discovery/query";
import { withQuotedPost } from "@/lib/posts/quotedPost";
import type { NormalizedCandidatePost } from "@/lib/posts/types";
import { getScoutLimits, type ScoutLimits } from "@/lib/scout/testLimits";
import type { BudgetExhausted, ScoutRunStats, XRunUsage } from "@/lib/scout/types";
import { searchRecentXPosts, XApiBudgetError } from "@/lib/x/client";
import { track } from "@/services/analytics/track";
import {
  freeCapacityReached,
  getUsageBudget,
  maxActiveWatchlist,
  scanBlockedBy,
  scoringAllowance,
} from "@/services/billing/budget";
import { rankCandidates } from "@/services/opportunities/rankCandidates";
import { importedSource } from "@/services/post-sources/imported";
import { PostSourceUnavailableError } from "@/services/post-sources/types";
import { xApiSource } from "@/services/post-sources/xApi";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { isUnverified } from "@/services/watchlist/addAccount";
import { ensureFreshPosts } from "@/services/x/sharedFetch";

import { mapSettled } from "./concurrency";
import { dedupePosts, filterCandidates, MAX_POST_AGE_DAYS } from "./filters";

/** A run still active after this long died mid-scan and blocks new runs */
const STALE_RUN_MINUTES = 15;

export type RunScoutResult =
  | { status: "no_active_accounts" }
  | { status: "already_running"; run: ScoutRun | undefined }
  /** Testing mode: daily run limit or minimum time between runs */
  | { status: "limited"; gate: RunGate }
  /** The plan's monthly X or scoring budget is used up; nothing was fetched */
  | { status: "budget_exhausted"; reason: BudgetExhausted }
  | { status: "completed"; run: ScoutRun; stats: ScoutRunStats }
  | { status: "failed"; run: ScoutRun; error: string };

/** What the fetch phase did for one watched account. */
type AccountScan = {
  account: WatchlistAccount;
  /** Verified on X: its posts come from the shared cache */
  fromCache: boolean;
  /** Fell back to the user's imported posts (X unavailable or unverified) */
  imported: NormalizedCandidatePost[];
  /** This run refreshed the shared cache (true), found it fresh (false), or neither */
  refreshed?: boolean;
  /** Another worker held the account's fetch; its cached posts were used as they are */
  busy?: boolean;
  /** Not fetched from X this run: the user's budget couldn't cover it (cached posts still delivered) */
  skippedForBudget?: boolean;
};

/** X won't return fewer than this many posts per request */
const MIN_X_PAGE = 5;
/** ...or fewer than this many from a search */
const MIN_SEARCH_PAGE = 10;

/** Shared by one run's account scans. */
type ScanContext = {
  profileId: string;
  limits: ScoutLimits;
  /** Accounts not started by then are skipped (testing mode's scan time limit) */
  deadline: number | null;
  lockWaitMs?: number;
  usage: XRunUsage;
  /** Posts each account's X fetch may read this run (missing: no budget cap) */
  fetchCaps: Map<string, number>;
};

/**
 * Day 23: the X posts a run may fetch, spread over the user's accounts. A
 * fetch reads at most what the user can still afford today, so a refresh this
 * user triggers never costs more than their budget, however the shared cache
 * is used later. Least recently scanned accounts go first when the budget
 * can't cover all of them; the rest still get their cached posts.
 */
export function planFetchCaps(
  accounts: Pick<WatchlistAccount, "id" | "lastScannedAt">[],
  affordableResources: number,
  limits: Pick<ScoutLimits, "maxPostsPerAccountFirstScan" | "maxPostsPerAccountSubsequentScan" | "fetchQuotePostsWithoutContext" | "fetchReplies">,
  /** Day 26: Smart Discovery topics share the same budget (search pages are 10+ posts, no quotes) */
  topics: Pick<DiscoveryTopic, "id" | "lastSearchedAt">[] = [],
): Map<string, number> {
  // With quotes expanded, a post can cost two resources (the quote and what it quotes)
  const accountPerPost = !limits.fetchQuotePostsWithoutContext && !limits.fetchReplies ? 2 : 1;
  const fullPage = Math.max(limits.maxPostsPerAccountFirstScan, limits.maxPostsPerAccountSubsequentScan);
  const units = [
    ...accounts.map((a) => ({ id: a.id, at: a.lastScannedAt, minPage: MIN_X_PAGE, perPost: accountPerPost })),
    ...topics.map((t) => ({ id: t.id, at: t.lastSearchedAt, minPage: MIN_SEARCH_PAGE, perPost: 1 })),
  ].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));

  const budget = Math.max(0, affordableResources);
  const caps = new Map<string, number>();
  const evenResources = Math.floor(budget / Math.max(1, units.length));
  if (units.every((unit) => Math.floor(evenResources / unit.perPost) >= unit.minPage)) {
    for (const unit of units) caps.set(unit.id, Math.min(Math.max(fullPage, unit.minPage), Math.floor(evenResources / unit.perPost)));
    return caps;
  }
  // Not enough for everything: minimum pages for as many as the budget covers, least recent first
  let left = budget;
  for (const unit of units) {
    const cost = unit.minPage * unit.perPost;
    if (left >= cost) {
      caps.set(unit.id, unit.minPage);
      left -= cost;
    } else caps.set(unit.id, 0);
  }
  return caps;
}

/**
 * RUN SCOUT, in two phases.
 * 1. Fetch (shared): make sure each watched account's posts are in the shared
 *    cache, asking X only when nobody fetched them recently (Day 17).
 * 2. Process (this user): deliver the cached posts this user hasn't had yet →
 *    filters → candidates → personal AI scoring → opportunities.
 * Every delivered post gets a scout_candidates row (scored later, or rejected
 * by a filter), so nothing is delivered, charged or evaluated twice, and
 * nothing undelivered is ever marked as processed.
 */
export type RunScoutOptions = {
  /** Who started it; recorded on the run */
  trigger?: ScoutRun["trigger"];
  /**
   * How long to wait for another worker's fetch of a watched account. The
   * scheduler passes 0: busy accounts are skipped and served next time.
   */
  lockWaitMs?: number;
};

export async function runScout(
  profileId: string,
  { trigger = "manual", lockWaitMs }: RunScoutOptions = {},
): Promise<RunScoutResult> {
  const profile = await getProfileById(profileId);
  if (!profile) throw new Error(`Profile ${profileId} not found`);
  const limits = getScoutLimits(profile.plan);
  // Also guards against more active accounts than the limit allows, e.g. two
  // accounts resumed at the same moment
  const accounts = (await getActiveWatchlist(profileId)).slice(0, maxActiveWatchlist(profile));
  // Day 26: active Smart Discovery topics, within the plan's limit
  const topics = (await getActiveDiscoveryTopics(profileId)).slice(
    0,
    effectiveLimits(profile.plan, profile.usageLimitOverrides).maxDiscoveryTopics,
  );
  if (accounts.length === 0 && topics.length === 0) return { status: "no_active_accounts" };

  // Checked before a run row exists: a refused scan costs and records nothing.
  // Only one run per profile can be active, so this budget can't be spent twice.
  const budget = await getUsageBudget(profile);
  const blockedBy = scanBlockedBy(budget);
  if (blockedBy) return { status: "budget_exhausted", reason: blockedBy };
  if (await freeCapacityReached(profile.plan)) return { status: "budget_exhausted", reason: "free_capacity" };

  // What X may still be asked for: today's budget minus cached posts already
  // waiting for this user (those are delivered first and cost the same)
  const waiting = await getUndeliveredCachedPosts(
    profileId,
    accounts.filter((account) => !isUnverified(account)).map((account) => account.platformUserId),
    { postedAfter: new Date(Date.now() - MAX_POST_AGE_DAYS * 86_400_000), limit: budget.remaining.xPostReads + 1 },
  );
  const waitingResources = waiting.reduce((sum, post) => sum + (post.quotedContent ? 2 : 1), 0);
  const fetchCaps = planFetchCaps(accounts, budget.remaining.xPostReads - waitingResources, limits, topics);

  await failStaleScoutRuns(
    profileId,
    new Date(Date.now() - STALE_RUN_MINUTES * 60_000),
  );
  const run = await startScoutRun(profileId, limits, trigger);
  if (!run) {
    const gate = await getRunGate(profileId, limits);
    return gate.blockedBy === "daily_limit" || gate.blockedBy === "min_gap"
      ? { status: "limited", gate }
      : { status: "already_running", run: await getActiveScoutRun(profileId) };
  }

  // The imports watermark is the scan's start, not its end: posts imported
  // while the scan runs come next time (database clock, like import times)
  const scanStartedAt = run.startedAt ?? new Date();
  const context: ScanContext = {
    profileId,
    limits,
    deadline: limits.maxScanDurationSeconds
      ? Date.now() + limits.maxScanDurationSeconds * 1000
      : null,
    lockWaitMs,
    fetchCaps,
    usage: {
      requests: 0,
      failed: 0,
      retried: 0,
      postsReturned: 0,
      includedReturned: 0,
      userLookups: 0,
    },
  };

  try {
    // ---- 1. Fetch: shared cache, one account at a time per slot ----------
    const settled = await mapSettled(accounts, limits.maxConcurrentXRequests, (account) =>
      scanAccount(context, account),
    );

    const scans: AccountScan[] = [];
    const failures: ScoutRunStats["failures"] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") scans.push(result.value);
      else failures.push({ handle: accounts[i].handle, reason: errorMessage(result.reason) });
    });

    // ---- 1b. Smart Discovery: one budgeted search per active topic ------
    const discovery = await searchTopics(context, profile, topics);
    failures.push(...discovery.failures);

    // ---- 2. Process: this user's undelivered cached posts ----------------
    const cachedAccounts = scans.filter((scan) => scan.fromCache).map((scan) => scan.account);
    const delivered = await deliverCachedPosts(
      profileId,
      cachedAccounts,
      // Search results are this user's own reads: what's left after them
      Math.max(0, budget.remaining.xPostReads - discovery.resources),
      scanStartedAt,
    );
    const imported = scans.flatMap(({ account, imported: posts }) =>
      posts.map((post) => ({ ...post, watchlistAccountId: account.id, source: importedSource.id })),
    );

    const fetched = [...delivered.posts, ...imported, ...discovery.posts];
    const { unique, duplicates } = dedupePosts(fetched);
    const alreadySeen = await getSeenPlatformPostIds(
      profileId,
      unique.map((post) => post.platformPostId),
    );
    const { candidates, filtered, rejected } = filterCandidates(unique, {
      now: scanStartedAt,
      alreadySeen,
      allowQuotesWithoutContext: limits.fetchQuotePostsWithoutContext,
    });

    const saved = await saveCandidates(run.id, profileId, candidates);
    // Filtered posts are recorded too: delivered and evaluated, never again
    await saveCandidates(run.id, profileId, rejected);
    // A concurrent writer got some first; count them as already seen
    filtered.already_seen += candidates.length - saved;

    await markWatchlistAccountsScanned(
      profileId,
      // Accounts skipped for budget stay "least recently scanned": first next time
      scans.filter((scan) => !scan.skippedForBudget).map((scan) => scan.account.id),
      scanStartedAt,
    );
    await recordXUsage({
      postsAccepted: candidates.filter((post) => post.source === xApiSource.id).length,
    });

    const stats: ScoutRunStats = {
      accountsTotal: accounts.length,
      accountsScanned: scans.length,
      accountsFailed: failures.length,
      postsFetched: fetched.length,
      duplicates,
      filtered,
      candidates: saved,
      sources: countBy(
        scans.flatMap((scan) => [
          ...(scan.fromCache ? [xApiSource.id] : []),
          ...(scan.imported.length || !scan.fromCache ? [importedSource.id] : []),
        ]),
      ),
      failures,
      xApi: context.usage,
      planXReads: delivered.resources + discovery.resources,
      sharedFetch: {
        fetched: scans.filter((scan) => scan.refreshed === true).length,
        reused: scans.filter((scan) => scan.refreshed === false).length,
        busy: scans.filter((scan) => scan.busy).length,
      },
    };
    if (delivered.budgetReached) {
      context.usage.stoppedReason ??=
        "Monthly X read budget reached; the remaining posts wait for next month.";
    }

    // Topics-only users (no watchlist) have no account scans: that's not a failure
    if (accounts.length > 0 && scans.length === 0) {
      const error = `All ${accounts.length} accounts failed to scan.`;
      return {
        status: "failed",
        run: await finishScoutRun(run.id, { status: "failed", error, stats }),
        error,
      };
    }

    // Day 9: rank this run's candidates plus any a previous run left unscored.
    // A scoring failure never fails the scan; unscored candidates retry later.
    try {
      stats.scoring = await rankCandidates(profileId, run.id, {
        maxCandidates: scoringAllowance(budget),
      });
    } catch (error) {
      console.error("Opportunity scoring failed", run.id, error);
      stats.scoring = {
        scored: 0,
        unscored: saved,
        surfaced: 0,
        skippedReason: "Scoring failed; candidates will be scored on the next run.",
      };
    }
    console.info("Scout run finished", run.id, stats);
    await recordXUsage({ runsCompleted: 1 });
    await track("first_scan_completed", { profileId, props: { trigger } });

    return {
      status: "completed",
      run: await finishScoutRun(run.id, { status: "completed", stats }),
      stats,
    };
  } catch (error) {
    console.error("Scout run failed", run.id, error);
    const message = errorMessage(error);
    return {
      status: "failed",
      run: await finishScoutRun(run.id, { status: "failed", error: message }),
      error: message,
    };
  }
}

/**
 * Phase 1 for one account: verify it if needed, then refresh its shared cache
 * when stale. Falls back to the user's imported posts when X is unavailable
 * (no token, no credits, daily budget used up); after the first such answer
 * the rest of the run doesn't call X again.
 */
async function scanAccount(
  context: ScanContext,
  account: WatchlistAccount,
): Promise<AccountScan> {
  const { profileId, limits, usage } = context;
  if (context.deadline !== null && Date.now() > context.deadline) {
    throw new Error(
      `Skipped: the scan reached its ${limits.maxScanDurationSeconds}s limit. It runs next time.`,
    );
  }
  const stopX = (error: PostSourceUnavailableError) => {
    usage.stoppedReason ??= error.message;
  };

  let current = account;
  if (isUnverified(current) && !usage.stoppedReason) {
    try {
      usage.userLookups = (usage.userLookups ?? 0) + 1;
      const profile = await xApiSource.resolveAccount(current.handle);
      if (!profile) throw new Error(`@${current.handle} doesn't exist on X.`);
      const verified = await verifyWatchlistAccount(profileId, current.id, profile);
      if (!verified) {
        throw new Error(`@${current.handle} is already on your watchlist under another entry.`);
      }
      current = verified;
    } catch (error) {
      // X is down, not the account: keep it unverified and use imports
      if (!(error instanceof PostSourceUnavailableError)) throw error;
      stopX(error);
    }
  }

  // The shared fetch reads full pages whatever this user's budget: one user's
  // budget must never shrink what other watchers get. The user's budget caps
  // what's delivered to them (phase 2), and they were refused a scan once it
  // was used up. Real X cost stays bounded by page size, cache freshness and
  // the run limits.
  const cap = context.fetchCaps.get(account.id) ?? Infinity;
  if (!isUnverified(current) && cap === 0) {
    // Over today's budget: no X request; already cached posts are still delivered
    return { account: current, fromCache: true, imported: [], skippedForBudget: true };
  }
  if (!isUnverified(current) && !usage.stoppedReason) {
    try {
      const result = await ensureFreshPosts(current, {
        firstLimit: Math.min(limits.maxPostsPerAccountFirstScan, cap),
        nextLimit: Math.min(limits.maxPostsPerAccountSubsequentScan, cap),
        lockWaitMs: context.lockWaitMs,
        // Older posts are filtered as too old; not fetching them saves credits
        notBefore: new Date(Date.now() - MAX_POST_AGE_DAYS * 86_400_000),
        usage,
      });
      return {
        account: current,
        fromCache: true,
        imported: [],
        // busy: another worker still fetching; neither refreshed nor reused
        refreshed: { fetched: true, fresh: false, waited: false, busy: undefined }[result.status],
        busy: result.status === "busy",
      };
    } catch (error) {
      if (!(error instanceof PostSourceUnavailableError)) throw error;
      stopX(error);
    }
  }

  // Verified accounts still get their cached posts (fetched earlier or by
  // another user); imports are added for every account X couldn't refresh
  const { posts } = await importedSource.fetchPosts({
    profileId,
    account: current,
    since: current.lastScannedAt,
    // Ignored by imports (free, and capped by import time instead)
    limit: limits.maxPostsPerAccountFirstScan,
  });
  return { account: current, fromCache: !isUnverified(current), imported: posts };
}

/**
 * Phase 2: the cached posts by these accounts this user hasn't been delivered,
 * newest first, as far as their monthly X budget reaches. A quote with its
 * quoted post costs 2 resources, like the X read it came from. Posts that
 * don't fit stay undelivered and come on a later run.
 */
async function deliverCachedPosts(
  profileId: string,
  accounts: WatchlistAccount[],
  readsLeft: number,
  now: Date,
): Promise<{
  posts: (NormalizedCandidatePost & { watchlistAccountId: string; source: string })[];
  resources: number;
  budgetReached: boolean;
}> {
  const byAuthor = new Map(accounts.map((account) => [account.platformUserId, account]));
  // One more than the budget can cover, to know whether anything is left over
  const cached = await getUndeliveredCachedPosts(profileId, [...byAuthor.keys()], {
    postedAfter: new Date(now.getTime() - MAX_POST_AGE_DAYS * 86_400_000),
    limit: readsLeft + 1,
  });

  const posts = [];
  let resources = 0;
  for (const post of cached) {
    const cost = post.quotedContent ? 2 : 1;
    if (resources + cost > readsLeft) break;
    resources += cost;
    posts.push({
      ...fromCache(post),
      watchlistAccountId: byAuthor.get(post.authorPlatformUserId)!.id,
      source: xApiSource.id,
    });
  }
  return { posts, resources, budgetReached: posts.length < cached.length };
}

function fromCache(post: XPost): NormalizedCandidatePost {
  return {
    platform: "x",
    platformPostId: post.platformPostId,
    authorPlatformUserId: post.authorPlatformUserId,
    authorHandle: post.authorHandle,
    content: post.quotedContent ? withQuotedPost(post.content, post.quotedContent) : post.content,
    url: post.url,
    postedAt: post.postedAt,
    kind: post.kind,
    ...(post.kind === "quote" && { quotedPostIncluded: Boolean(post.quotedContent) }),
    referencedPostIds: post.referencedPostIds,
    metrics: post.metrics ?? undefined,
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Day 26 Smart Discovery: one X recent search per active topic, for posts
 * newer than its last search, as many as this run's budget assigns it. The
 * results are this user's own (not shared), charged to their X budget like
 * delivered posts, and go through the same filters and scoring. A topic over
 * budget is skipped this time; a failing search never fails the scan.
 */
async function searchTopics(
  context: ScanContext,
  profile: Profile,
  topics: DiscoveryTopic[],
): Promise<{
  posts: (NormalizedCandidatePost & { watchlistAccountId: null; discoveryTopicId: string; source: string })[];
  resources: number;
  failures: ScoutRunStats["failures"];
}> {
  const posts = [];
  const failures: ScoutRunStats["failures"] = [];
  let resources = 0;
  const language = languageCode(resolveScoutBrain(profile)?.voice.languages);

  for (const topic of topics) {
    const cap = context.fetchCaps.get(topic.id) ?? 0;
    const query = buildSearchQuery(topic, { language });
    if (cap === 0 || !query || context.usage.stoppedReason) continue;
    try {
      const result = await searchRecentXPosts(
        {
          query,
          limit: cap,
          sinceId: topic.sinceId,
          startTime: new Date(Date.now() - MAX_POST_AGE_DAYS * 86_400_000),
        },
        context.usage,
      );
      resources += result.posts.length;
      posts.push(
        ...result.posts.map((post) => ({
          ...post,
          watchlistAccountId: null,
          discoveryTopicId: topic.id,
          source: X_SEARCH_SOURCE,
        })),
      );
      await markTopicSearched(topic.id, result.newestId, new Date());
    } catch (error) {
      failures.push({ handle: `topic: ${topic.name}`, reason: errorMessage(error) });
      // Out of X budget or credits: no more searches this run
      if (error instanceof XApiBudgetError) context.usage.stoppedReason ??= error.message;
    }
  }
  return { posts, resources, failures };
}

/** Candidate source of Smart Discovery results */
export const X_SEARCH_SOURCE = "x_search";
