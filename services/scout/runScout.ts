import "server-only";

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
  setWatchlistXCursor,
  verifyWatchlistAccount,
} from "@/db/queries/watchlist";
import { recordXUsage } from "@/db/queries/xApiUsage";
import type { ScoutRun, WatchlistAccount } from "@/db/schema";
import type { NormalizedCandidatePost } from "@/lib/posts/types";
import { getScoutLimits, type ScoutLimits } from "@/lib/scout/testLimits";
import type { ScoutRunStats, XRunUsage, XScanCursor } from "@/lib/scout/types";
import { rankCandidates } from "@/services/opportunities/rankCandidates";
import { importedSource } from "@/services/post-sources/imported";
import {
  type PostSource,
  PostSourceUnavailableError,
} from "@/services/post-sources/types";
import { xApiSource } from "@/services/post-sources/xApi";
import { isUnverified } from "@/services/watchlist/addAccount";

import { mapSettled } from "./concurrency";
import { dedupePosts, filterCandidates, MAX_POST_AGE_DAYS } from "./filters";

/** A run still active after this long died mid-scan and blocks new runs */
const STALE_RUN_MINUTES = 15;

export type RunScoutResult =
  | { status: "no_active_accounts" }
  | { status: "already_running"; run: ScoutRun | undefined }
  /** Testing mode: daily run limit or minimum time between runs */
  | { status: "limited"; gate: RunGate }
  | { status: "completed"; run: ScoutRun; stats: ScoutRunStats }
  | { status: "failed"; run: ScoutRun; error: string };

type AccountScan = {
  account: WatchlistAccount;
  source: PostSource["id"];
  posts: NormalizedCandidatePost[];
  /** X only; undefined leaves the account's cursor as it is */
  nextCursor?: XScanCursor | null;
};

/** Shared by one run's account scans. */
type ScanContext = {
  profileId: string;
  limits: ScoutLimits;
  /** Accounts not started by then are skipped (testing mode's scan time limit) */
  deadline: number | null;
  usage: XRunUsage;
};

/**
 * RUN SCOUT: active watchlist → fetch only new posts → normalize → dedupe →
 * basic filters → candidates for the Day 9 Opportunity Engine.
 */
export async function runScout(profileId: string): Promise<RunScoutResult> {
  const limits = getScoutLimits();
  // Also guards against more active accounts than the limit allows, e.g. two
  // accounts resumed at the same moment
  const accounts = (await getActiveWatchlist(profileId)).slice(
    0,
    limits.maxWatchlistAccounts ?? undefined,
  );
  if (accounts.length === 0) return { status: "no_active_accounts" };

  await failStaleScoutRuns(
    profileId,
    new Date(Date.now() - STALE_RUN_MINUTES * 60_000),
  );
  const run = await startScoutRun(profileId, limits);
  if (!run) {
    const gate = await getRunGate(profileId, limits);
    return gate.blockedBy === "daily_limit" || gate.blockedBy === "min_gap"
      ? { status: "limited", gate }
      : { status: "already_running", run: await getActiveScoutRun(profileId) };
  }

  // The watermark is the scan's start, not its end: posts published while the
  // scan runs are fetched again next time and deduplicated, never skipped
  // (set by the database clock, so it compares cleanly with import times)
  const scanStartedAt = run.startedAt ?? new Date();
  const context: ScanContext = {
    profileId,
    limits,
    deadline: limits.maxScanDurationSeconds
      ? Date.now() + limits.maxScanDurationSeconds * 1000
      : null,
    usage: { requests: 0, failed: 0, retried: 0, postsReturned: 0 },
  };

  try {
    // Each account makes its X requests one after another, so this also caps
    // concurrent X requests
    const settled = await mapSettled(accounts, limits.maxConcurrentXRequests, (account) =>
      scanAccount(context, account),
    );

    const scans: AccountScan[] = [];
    const failures: ScoutRunStats["failures"] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") scans.push(result.value);
      else failures.push({ handle: accounts[i].handle, reason: errorMessage(result.reason) });
    });

    const fetched = scans.flatMap(({ account, source, posts }) =>
      posts.map((post) => ({ ...post, watchlistAccountId: account.id, source })),
    );
    const { unique, duplicates } = dedupePosts(fetched);
    const alreadySeen = await getSeenPlatformPostIds(
      profileId,
      unique.map((post) => post.platformPostId),
    );
    const { candidates, filtered } = filterCandidates(unique, {
      now: scanStartedAt,
      alreadySeen,
      allowQuotesWithoutContext: limits.fetchQuotePostsWithoutContext,
    });

    const saved = await saveCandidates(run.id, profileId, candidates);
    // A concurrent writer got some first; count them as already seen
    filtered.already_seen += candidates.length - saved;

    // Only after candidates are safely stored, and only for accounts that
    // succeeded: a failed account retries the same window and the same X
    // posts next run
    await Promise.all(
      scans
        .filter((scan) => scan.nextCursor !== undefined)
        .map((scan) => setWatchlistXCursor(profileId, scan.account.id, scan.nextCursor ?? null)),
    );
    await markWatchlistAccountsScanned(
      profileId,
      scans.map((scan) => scan.account.id),
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
      sources: countBy(scans.map((scan) => scan.source)),
      failures,
      xApi: context.usage,
    };

    if (scans.length === 0) {
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
      stats.scoring = await rankCandidates(profileId, run.id);
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
 * One account: verify it if needed, then fetch its new posts from the X API,
 * falling back to imported posts when X is unavailable (no token, no credits,
 * daily budget used up). After the first such answer the rest of the run
 * doesn't call X again.
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

  if (!isUnverified(current) && !usage.stoppedReason) {
    try {
      const result = await xApiSource.fetchPosts({
        profileId,
        account: current,
        since: current.lastScannedAt,
        limit: current.xCursor
          ? limits.maxPostsPerAccountSubsequentScan
          : limits.maxPostsPerAccountFirstScan,
        // Older posts are filtered as too old; not fetching them saves credits
        notBefore: new Date(Date.now() - MAX_POST_AGE_DAYS * 86_400_000),
        usage,
      });
      return { account: current, source: xApiSource.id, ...result };
    } catch (error) {
      if (!(error instanceof PostSourceUnavailableError)) throw error;
      stopX(error);
    }
  }

  const { posts } = await importedSource.fetchPosts({
    profileId,
    account: current,
    since: current.lastScannedAt,
    // Ignored by imports (free, and capped by import time instead)
    limit: limits.maxPostsPerAccountFirstScan,
  });
  return { account: current, source: importedSource.id, posts };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
