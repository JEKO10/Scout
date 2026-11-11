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
  /**
   * Post resources X may return per UTC day across all of Scout: the global
   * spending cap. SCOUT_X_DAILY_POST_READ_LIMIT overrides it.
   */
  maxXPostReadsPerDay: number | null;
  /** Scans (manual or automatic) running at once across all instances */
  maxConcurrentScans: number;
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
  maxXPostReadsPerDay: 1_000,
  maxConcurrentScans: 1,
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
  maxXPostReadsPerDay: null,
  maxConcurrentScans: 3,
  fetchReplies: true,
  fetchReposts: false,
  fetchQuotePostsWithoutContext: true,
  fetchParentPosts: false,
};

export function isScoutTestMode(): boolean {
  return process.env.SCOUT_TEST_MODE === "true";
}

export function getScoutLimits(): ScoutLimits {
  const limits = isScoutTestMode() ? SCOUT_TEST_LIMITS : SCOUT_DEFAULT_LIMITS;
  const dailyReads = Number(process.env.SCOUT_X_DAILY_POST_READ_LIMIT);
  return Number.isFinite(dailyReads) && dailyReads > 0
    ? { ...limits, maxXPostReadsPerDay: dailyReads }
    : limits;
}
