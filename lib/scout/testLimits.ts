// X API Testing Mode: temporary limits for testing Scout on real X data with a
// small prepaid credit balance. Not product limits. Turn on with
// SCOUT_TEST_MODE=true; everything that reads a limit goes through getScoutLimits().

export type ScoutLimits = {
  /** Active watchlist accounts; null: only the total watchlist limit applies */
  maxWatchlistAccounts: number | null;
  /** Non-failed runs per rolling 24 hours */
  maxRunsPerDay: number | null;
  maxPostsPerAccountFirstScan: number;
  maxPostsPerAccountSubsequentScan: number;
  /** Since the start of the last completed run */
  minMinutesBetweenRuns: number | null;
  maxConcurrentXRequests: number;
  /** Retries per request, only for temporary failures (5xx, network, short rate limits) */
  maxXRetries: number;
  maxScanDurationSeconds: number | null;
  /** Attempted requests per UTC day across all of Scout: one X token, one balance */
  maxXRequestsPerDay: number | null;
  fetchReplies: boolean;
  fetchReposts: boolean;
  fetchQuotePostsWithoutContext: boolean;
  /** Scout never fetches parent posts; kept so the setting is explicit */
  fetchParentPosts: false;
};

export const SCOUT_TEST_LIMITS: ScoutLimits = {
  maxWatchlistAccounts: 10,
  maxRunsPerDay: 3,
  maxPostsPerAccountFirstScan: 20,
  maxPostsPerAccountSubsequentScan: 10,
  minMinutesBetweenRuns: 180,
  maxConcurrentXRequests: 2,
  maxXRetries: 1,
  maxScanDurationSeconds: 120,
  maxXRequestsPerDay: 100,
  fetchReplies: false,
  fetchReposts: false,
  fetchQuotePostsWithoutContext: false,
  fetchParentPosts: false,
};

/** Testing mode off: Scout's behavior before testing mode existed. */
const SCOUT_DEFAULT_LIMITS: ScoutLimits = {
  maxWatchlistAccounts: null,
  maxRunsPerDay: null,
  maxPostsPerAccountFirstScan: 20,
  maxPostsPerAccountSubsequentScan: 50,
  minMinutesBetweenRuns: null,
  maxConcurrentXRequests: 3,
  maxXRetries: 1,
  maxScanDurationSeconds: null,
  maxXRequestsPerDay: null,
  fetchReplies: true,
  fetchReposts: false,
  fetchQuotePostsWithoutContext: true,
  fetchParentPosts: false,
};

export function isScoutTestMode(): boolean {
  return process.env.SCOUT_TEST_MODE === "true";
}

export function getScoutLimits(): ScoutLimits {
  return isScoutTestMode() ? SCOUT_TEST_LIMITS : SCOUT_DEFAULT_LIMITS;
}
