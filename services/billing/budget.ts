import "server-only";

import { getAiCostByOperation, getScoringCostPerCandidate } from "@/db/queries/aiUsage";
import { sumRunXPostReads } from "@/db/queries/scoutRuns";
import type { Profile } from "@/db/schema";
import { effectiveLimits, type PlanId, type UsageLimits } from "@/lib/billing/plans";
import { getScoutLimits } from "@/lib/scout/testLimits";
import type { BudgetExhausted } from "@/lib/scout/types";

/** Used until the profile has scored runs to average over */
const DEFAULT_SCORING_USD_PER_CANDIDATE = 0.01;

type Amounts = { xPostReads: number; scoringUsd: number; replyUsd: number };

export type UsageBudget = {
  plan: PlanId;
  limits: UsageLimits;
  used: Amounts;
  remaining: Amounts;
  /** Start of the current period: the calendar month, UTC */
  periodStart: Date;
  /** Recent average, to turn the scoring budget into a candidate count */
  scoringUsdPerCandidate: number;
};

export function currentPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The profile's monthly usage against its plan, from what Scout already
 * records: run stats for X reads, ai_usage for OpenAI spend. Estimates, not
 * provider bills.
 */
export async function getUsageBudget(
  profile: Pick<Profile, "id" | "plan" | "usageLimitOverrides">,
): Promise<UsageBudget> {
  const periodStart = currentPeriodStart();
  const [xPostReads, aiRows, perCandidate] = await Promise.all([
    sumRunXPostReads(profile.id, periodStart),
    getAiCostByOperation(profile.id, periodStart),
    getScoringCostPerCandidate(profile.id, new Date(Date.now() - 30 * 86_400_000)),
  ]);
  const cost = (operation: string) =>
    aiRows.find((row) => row.operation === operation)?.costUsd ?? 0;

  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  const used = {
    xPostReads,
    scoringUsd: cost("opportunity_scoring"),
    replyUsd: cost("reply_generation"),
  };
  return {
    plan: profile.plan,
    limits,
    used,
    remaining: {
      xPostReads: Math.max(0, limits.monthlyXPostReads - used.xPostReads),
      scoringUsd: Math.max(0, limits.monthlyScoringUsd - used.scoringUsd),
      replyUsd: Math.max(0, limits.monthlyReplyUsd - used.replyUsd),
    },
    periodStart,
    scoringUsdPerCandidate: perCandidate ?? DEFAULT_SCORING_USD_PER_CANDIDATE,
  };
}

/**
 * Why a scan shouldn't start. Without scoring budget a scan would pay X for
 * posts that can't be scored before they go stale.
 */
export function scanBlockedBy(budget: UsageBudget): BudgetExhausted | null {
  if (budget.remaining.xPostReads <= 0) return "x_reads";
  if (budget.remaining.scoringUsd <= 0) return "scoring";
  return null;
}

/** Candidates one run may score: the plan's cap, or fewer when money is short. */
export function scoringAllowance(budget: UsageBudget): number {
  const affordable = Math.floor(budget.remaining.scoringUsd / budget.scoringUsdPerCandidate);
  return Math.max(0, Math.min(budget.limits.maxCandidatesPerRun, affordable));
}

/** Active watchlist accounts allowed: the plan's limit, lowered in testing mode. */
export function maxActiveWatchlist(
  profile: Pick<Profile, "plan" | "usageLimitOverrides">,
): number {
  const planLimit = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxActiveWatchlist;
  const testLimit = getScoutLimits().maxWatchlistAccounts;
  return testLimit === null ? planLimit : Math.min(planLimit, testLimit);
}

export const BUDGET_MESSAGES: Record<BudgetExhausted, string> = {
  x_reads: "Your monthly X read budget is used up. Scans resume next month.",
  scoring: "Your monthly AI scoring budget is used up. Scans resume next month.",
  replies: "Your monthly reply generation budget is used up. It resets next month.",
};
