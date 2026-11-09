import "server-only";

import { getRecentScoutRuns, getRunGate } from "@/db/queries/scoutRuns";
import { countActiveWatchlist } from "@/db/queries/watchlist";
import { getXUsageToday } from "@/db/queries/xApiUsage";
import type { ScoutRun } from "@/db/schema";
import { getScoutLimits, isScoutTestMode } from "@/lib/scout/testLimits";

export type ScoutTestStatus = {
  enabled: boolean;
  runsUsed: number;
  maxRuns: number | null;
  /** All of Scout today (UTC): one token, one balance */
  requestsToday: number;
  maxRequests: number | null;
  activeAccounts: number;
  maxActiveAccounts: number | null;
  lastSuccessfulScanAt: Date | null;
  /** Null: a scan can run now */
  nextEligibleAt: Date | null;
  lastRun: ScoutRun | undefined;
};

/** Everything the testing panels show, for one profile. */
export async function getScoutTestStatus(
  profileId: string,
): Promise<ScoutTestStatus> {
  const limits = getScoutLimits();
  const [gate, usage, activeAccounts, runs] = await Promise.all([
    getRunGate(profileId, limits),
    getXUsageToday(),
    countActiveWatchlist(profileId),
    getRecentScoutRuns(profileId, 10),
  ]);
  const lastSuccessful = runs.find((run) => run.status === "completed");

  return {
    enabled: isScoutTestMode(),
    runsUsed: gate.runsLast24h,
    maxRuns: limits.maxRunsPerDay,
    requestsToday: usage?.requests ?? 0,
    maxRequests: limits.maxXRequestsPerDay,
    activeAccounts,
    maxActiveAccounts: limits.maxWatchlistAccounts,
    lastSuccessfulScanAt: lastSuccessful?.completedAt ?? null,
    nextEligibleAt: gate.nextEligibleAt,
    lastRun: runs[0],
  };
}
