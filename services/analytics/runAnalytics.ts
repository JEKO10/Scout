import "server-only";

import { getRunsAiCost } from "@/db/queries/aiUsage";
import { getRecentScoutRuns } from "@/db/queries/scoutRuns";
import type { Profile } from "@/db/schema";
import { estimateXCostUsd } from "@/lib/x/pricing";
import { getUsageBudget, type UsageBudget } from "@/services/billing/budget";

export type RunAnalytics = {
  id: string;
  startedAt: Date;
  status: string;
  accounts: string;
  xRequests: number | null;
  userLookups: number | null;
  /** Post resources X returned (billed), quoted posts included */
  postResources: number | null;
  /** Of postResources: quoted posts read for context */
  quotedReads: number | null;
  posts: number | null;
  candidates: number | null;
  scored: number | null;
  opportunities: number;
  scoringUsd: number;
  replyUsd: number;
  xUsd: number;
  totalUsd: number;
  costPerOpportunity: number | null;
  note: string | null;
};

/**
 * Development view: what each recent run read, found and cost. X cost is
 * estimated from read counts and lib/x/pricing.ts; AI cost from ai_usage.
 */
export async function getRunAnalytics(
  profile: Pick<Profile, "id" | "plan" | "usageLimitOverrides">,
  limit = 20,
): Promise<{ runs: RunAnalytics[]; budget: UsageBudget }> {
  const runs = await getRecentScoutRuns(profile.id, limit);
  const [aiCosts, budget] = await Promise.all([
    getRunsAiCost(
      profile.id,
      runs.map((run) => run.id),
    ),
    getUsageBudget(profile),
  ]);

  return {
    budget,
    runs: runs.map((run) => {
      const stats = run.stats;
      const x = stats?.xApi;
      const onlyX = stats ? Object.keys(stats.sources).every((source) => source === "x_api") : false;
      // Older runs didn't count quoted reads; with X as the only source the
      // difference between resources and posts is exactly those
      const quotedReads =
        x?.includedReturned ?? (x && onlyX ? x.postsReturned - stats.postsFetched : null);
      const ai = aiCosts.get(run.id);
      const xUsd = x
        ? estimateXCostUsd({ postReads: x.postsReturned, userReads: x.userLookups ?? 0 })
        : 0;
      const scoringUsd = ai?.scoringUsd ?? 0;
      const replyUsd = ai?.replyUsd ?? 0;
      const totalUsd = xUsd + scoringUsd + replyUsd;

      return {
        id: run.id,
        startedAt: run.startedAt ?? run.createdAt,
        status: run.status,
        accounts: stats ? `${stats.accountsScanned}/${stats.accountsTotal}` : "–",
        xRequests: x?.requests ?? null,
        userLookups: x?.userLookups ?? null,
        postResources: x?.postsReturned ?? null,
        quotedReads,
        posts: stats?.postsFetched ?? null,
        candidates: stats?.candidates ?? null,
        scored: stats?.scoring?.scored ?? null,
        opportunities: run.opportunitiesFound,
        scoringUsd,
        replyUsd,
        xUsd,
        totalUsd,
        costPerOpportunity: run.opportunitiesFound > 0 ? totalUsd / run.opportunitiesFound : null,
        note: x?.stoppedReason ?? run.error ?? stats?.scoring?.skippedReason ?? null,
      };
    }),
  };
}
