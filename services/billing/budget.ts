import "server-only";

import { getAiCostByOperation, getScoringCostPerCandidate } from "@/db/queries/aiUsage";
import { sumGrowthXPostReads } from "@/db/queries/growth";
import { sumPeerXPostReads } from "@/db/queries/peers";
import { sumRunXPostReads } from "@/db/queries/scoutRuns";
import { getXUsageToday } from "@/db/queries/xApiUsage";
import type { Profile } from "@/db/schema";
import { isMissingSchemaError, missingSchemaMessage } from "@/db/schemaErrors";
import { effectiveLimits, type PlanId, type UsageLimits } from "@/lib/billing/plans";
import { getScoutLimits } from "@/lib/scout/testLimits";
import type { BudgetExhausted } from "@/lib/scout/types";

const PEER_MIGRATION = "20261118002427_peer_intelligence";

/** Used until the profile has scored runs to average over */
const DEFAULT_SCORING_USD_PER_CANDIDATE = 0.01;

/**
 * Daily pacing: this share of the month is available on the 1st (so a first
 * scan is useful), the rest accrues evenly day by day. Unused allowance
 * carries forward until the month ends.
 */
export const PACING_UPFRONT_SHARE = 0.2;

/**
 * Free users may use at most this share of Scout's global daily X caps
 * (testing mode), so paying users always have room.
 */
export const FREE_GLOBAL_X_SHARE = 0.5;

type Amounts = { xPostReads: number; scoringUsd: number; replyUsd: number };

export type UsageBudget = {
  plan: PlanId;
  limits: UsageLimits;
  used: Amounts;
  /** What can be spent now: paced for X reads and scoring, monthly for replies */
  remaining: Amounts;
  /** What's left of the whole month, ignoring pacing */
  monthRemaining: Amounts;
  /** Share of the month accrued so far (1 without pacing) */
  accruedShare: number;
  /** Start of the current period: the calendar month, UTC */
  periodStart: Date;
  /** Recent average, to turn the scoring budget into a candidate count */
  scoringUsdPerCandidate: number;
};

export function currentPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Next UTC midnight: when the next day's allowance accrues */
export function nextAccrualAt(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * Share of the monthly allowance available by the end of today (UTC): the
 * upfront share plus an equal part for each day so far, today included.
 */
export function accruedShareOfMonth(now = new Date()): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const day = now.getUTCDate();
  return Math.min(1, PACING_UPFRONT_SHARE + (1 - PACING_UPFRONT_SHARE) * (day / daysInMonth));
}

/**
 * The profile's usage against its plan, from what Scout already records:
 * run stats for X reads, ai_usage for OpenAI spend. Estimates, not provider
 * bills.
 */
export async function getUsageBudget(
  profile: Pick<Profile, "id" | "plan" | "usageLimitOverrides">,
  now = new Date(),
): Promise<UsageBudget> {
  const periodStart = currentPeriodStart(now);
  const [scanXPostReads, growthXPostReads, peerXPostReads, aiRows, perCandidate] = await Promise.all([
    sumRunXPostReads(profile.id, periodStart),
    // Day 33: Growth refreshes read the user's own posts from the same allowance
    sumGrowthXPostReads(profile.id, periodStart),
    // Day 35: peer refreshes (when enabled) read from the same allowance. A
    // database without the peer tables has recorded no refresh: 0 is exact,
    // and the missing migration is logged, not hidden.
    sumPeerXPostReads(profile.id, periodStart).catch((error: unknown) => {
      if (!isMissingSchemaError(error)) throw error;
      console.error(missingSchemaMessage("Peer refresh accounting", PEER_MIGRATION));
      return 0;
    }),
    getAiCostByOperation(profile.id, periodStart),
    getScoringCostPerCandidate(profile.id, new Date(now.getTime() - 30 * 86_400_000)),
  ]);
  const cost = (operation: string) =>
    aiRows.find((row) => row.operation === operation)?.costUsd ?? 0;

  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  const used = {
    xPostReads: scanXPostReads + growthXPostReads + peerXPostReads,
    // Discovery keyword suggestions are scoring-side AI work: same allowance
    scoringUsd: cost("opportunity_scoring") + cost("discovery_keywords") + cost("lead_icp") + cost("lead_classification") + cost("trend_insight") + cost("growth_strategy"),
    // Day 31: Content Studio writing shares the reply (writing) budget
    replyUsd: cost("reply_generation") + cost("content_ideas") + cost("content_generation") + cost("content_review"),
  };
  const monthRemaining = {
    xPostReads: Math.max(0, limits.monthlyXPostReads - used.xPostReads),
    scoringUsd: Math.max(0, limits.monthlyScoringUsd - used.scoringUsd),
    replyUsd: Math.max(0, limits.monthlyReplyUsd - used.replyUsd),
  };
  const accruedShare = limits.dailyPacing ? accruedShareOfMonth(now) : 1;
  return {
    plan: profile.plan,
    limits,
    used,
    monthRemaining,
    accruedShare,
    remaining: {
      // Accrued so far minus everything used this month: unused days carry forward
      xPostReads: Math.max(0, Math.floor(limits.monthlyXPostReads * accruedShare) - used.xPostReads),
      scoringUsd: Math.max(0, limits.monthlyScoringUsd * accruedShare - used.scoringUsd),
      replyUsd: monthRemaining.replyUsd,
    },
    periodStart,
    scoringUsdPerCandidate: perCandidate ?? DEFAULT_SCORING_USD_PER_CANDIDATE,
  };
}

/**
 * Why a scan shouldn't start. Without scoring budget a scan would pay X for
 * posts that can't be scored before they go stale. "_today": the month has
 * budget left, but today's paced share is used up.
 */
export function scanBlockedBy(budget: UsageBudget): BudgetExhausted | null {
  if (budget.monthRemaining.xPostReads <= 0) return "x_reads";
  if (budget.monthRemaining.scoringUsd <= 0) return "scoring";
  if (budget.remaining.xPostReads <= 0) return "x_reads_today";
  if (budget.remaining.scoringUsd <= 0) return "scoring_today";
  return null;
}

/** Whether a blocked scan can run again tomorrow (paced) or only next month */
export function blockedUntilTomorrow(reason: BudgetExhausted): boolean {
  return reason === "x_reads_today" || reason === "scoring_today" || reason === "free_capacity";
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
  const testLimit = getScoutLimits(profile.plan).maxWatchlistAccounts;
  return testLimit === null ? planLimit : Math.min(planLimit, testLimit);
}

/**
 * Fair use of Scout's global daily X caps (testing mode): Free scans stop
 * once Free has used its share, paid plans can use all of it.
 */
export async function freeCapacityReached(plan: PlanId): Promise<boolean> {
  if (plan !== "free") return false;
  const { maxXRequestsPerDay, maxXPostReadsPerDay } = getScoutLimits(plan);
  if (maxXRequestsPerDay === null && maxXPostReadsPerDay === null) return false;
  const today = await getXUsageToday();
  return (
    (maxXRequestsPerDay !== null && (today?.requests ?? 0) >= maxXRequestsPerDay * FREE_GLOBAL_X_SHARE) ||
    (maxXPostReadsPerDay !== null && (today?.postsReturned ?? 0) >= maxXPostReadsPerDay * FREE_GLOBAL_X_SHARE)
  );
}

export const BUDGET_MESSAGES: Record<BudgetExhausted, string> = {
  x_reads: "Your monthly X read budget is used up. Scans resume next month.",
  scoring: "Your monthly AI scoring budget is used up. Scans resume next month.",
  x_reads_today:
    "Today's share of your X reading budget is used up. More becomes available tomorrow (00:00 UTC); unused days carry over.",
  scoring_today:
    "Today's share of your AI scoring budget is used up. More becomes available tomorrow (00:00 UTC); unused days carry over.",
  free_capacity:
    "Scout's shared capacity for Free scans is used up for today. Free scans resume tomorrow (00:00 UTC); paid plans aren't affected.",
  replies: "Your monthly reply generation budget is used up. It resets next month.",
};
