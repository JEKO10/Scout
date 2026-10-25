import "server-only";

import { getSeenPlatformPostIds, saveCandidates } from "@/db/queries/scoutCandidates";
import {
  failStaleScoutRuns,
  finishScoutRun,
  getActiveScoutRun,
  startScoutRun,
} from "@/db/queries/scoutRuns";
import {
  getActiveWatchlist,
  markWatchlistAccountsScanned,
  verifyWatchlistAccount,
} from "@/db/queries/watchlist";
import type { ScoutRun, WatchlistAccount } from "@/db/schema";
import type { NormalizedCandidatePost } from "@/lib/posts/types";
import type { ScoutRunStats } from "@/lib/scout/types";
import { rankCandidates } from "@/services/opportunities/rankCandidates";
import { importedSource } from "@/services/post-sources/imported";
import {
  type PostSource,
  PostSourceUnavailableError,
} from "@/services/post-sources/types";
import { xApiSource } from "@/services/post-sources/xApi";
import { isUnverified } from "@/services/watchlist/addAccount";

import { mapSettled } from "./concurrency";
import { dedupePosts, filterCandidates } from "./filters";

/** Accounts scanned in parallel; small enough for provider rate limits */
const CONCURRENCY = 3;
/** First scan of an account: only its latest posts, not its whole history */
const FIRST_SCAN_LIMIT = 20;
const LATER_SCAN_LIMIT = 50;
/** A run still active after this long died mid-scan and blocks new runs */
const STALE_RUN_MINUTES = 15;

export type RunScoutResult =
  | { status: "no_active_accounts" }
  | { status: "already_running"; run: ScoutRun | undefined }
  | { status: "completed"; run: ScoutRun; stats: ScoutRunStats }
  | { status: "failed"; run: ScoutRun; error: string };

type AccountScan = {
  account: WatchlistAccount;
  source: PostSource["id"];
  posts: NormalizedCandidatePost[];
};

/**
 * RUN SCOUT: active watchlist → fetch only new posts → normalize → dedupe →
 * basic filters → candidates for the Day 9 Opportunity Engine.
 */
export async function runScout(profileId: string): Promise<RunScoutResult> {
  const accounts = await getActiveWatchlist(profileId);
  if (accounts.length === 0) return { status: "no_active_accounts" };

  await failStaleScoutRuns(
    profileId,
    new Date(Date.now() - STALE_RUN_MINUTES * 60_000),
  );
  const run = await startScoutRun(profileId);
  if (!run) {
    return { status: "already_running", run: await getActiveScoutRun(profileId) };
  }

  // The watermark is the scan's start, not its end: posts published while the
  // scan runs are fetched again next time and deduplicated, never skipped
  // (set by the database clock, so it compares cleanly with import times)
  const scanStartedAt = run.startedAt ?? new Date();

  try {
    const settled = await mapSettled(accounts, CONCURRENCY, (account) =>
      scanAccount(profileId, account),
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
    });

    const saved = await saveCandidates(run.id, profileId, candidates);
    // A concurrent writer got some first; count them as already seen
    filtered.already_seen += candidates.length - saved;

    // Only after candidates are safely stored, and only for accounts that
    // succeeded: a failed account retries the same window next run
    await markWatchlistAccountsScanned(
      profileId,
      scans.map((scan) => scan.account.id),
      scanStartedAt,
    );

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
 * falling back to imported posts when X is unavailable (no token, no credits).
 */
async function scanAccount(
  profileId: string,
  account: WatchlistAccount,
): Promise<AccountScan> {
  let current = account;

  if (isUnverified(current)) {
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
    }
  }

  const input = {
    profileId,
    account: current,
    since: current.lastScannedAt,
    limit: current.lastScannedAt ? LATER_SCAN_LIMIT : FIRST_SCAN_LIMIT,
  };

  if (!isUnverified(current)) {
    try {
      return { account: current, source: xApiSource.id, posts: await xApiSource.fetchPosts(input) };
    } catch (error) {
      if (!(error instanceof PostSourceUnavailableError)) throw error;
    }
  }
  return {
    account: current,
    source: importedSource.id,
    posts: await importedSource.fetchPosts(input),
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
