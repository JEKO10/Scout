import "server-only";

import { getRecentJobs } from "@/db/queries/scanJobs";
import type { Profile } from "@/db/schema";
import { PLANS } from "@/lib/billing/plans";

import { autoScanInterval } from "./tick";

export type AutoScoutStatus = {
  enabled: boolean;
  intervalMinutes: number;
  /** What the user's plan offers */
  intervals: number[];
  lastAutoScanAt: Date | null;
  nextScanAt: Date | null;
  /** The most recent job, for "what happened last time" */
  lastJob: {
    status: string;
    skipReason: string | null;
    error: string | null;
    at: Date;
  } | null;
};

export async function getAutoScoutStatus(profile: Profile): Promise<AutoScoutStatus> {
  const [job] = await getRecentJobs(profile.id, 1);
  return {
    enabled: profile.autoScanEnabled,
    intervalMinutes: autoScanInterval(profile),
    intervals: PLANS[profile.plan].autoScan.intervalsMinutes,
    lastAutoScanAt: profile.lastAutoScanAt,
    nextScanAt: profile.autoScanEnabled ? profile.nextScanAt : null,
    lastJob: job
      ? {
          status: job.status,
          skipReason: job.skipReason,
          error: job.error,
          at: job.finishedAt ?? job.updatedAt,
        }
      : null,
  };
}
