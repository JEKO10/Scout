// Subscription plans and their usage limits, in one place. No payments yet:
// a profile has a plan, and Scout enforces the plan's limits server-side.
// Numbers are starting points to tune with real usage, not final prices.

export type UsageLimits = {
  /** X post resources read per calendar month (UTC), quoted posts included */
  monthlyXPostReads: number;
  /** Estimated OpenAI spend on opportunity scoring per month, USD */
  monthlyScoringUsd: number;
  /** Estimated OpenAI spend on reply generation per month, USD */
  monthlyReplyUsd: number;
  maxActiveWatchlist: number;
  /** Candidates the AI scores in one run; the rest wait for the next run */
  maxCandidatesPerRun: number;
};

/** Automatic Scout (Day 18): how often a plan may scan on its own. */
export type AutoScanSettings = {
  /** Intervals the user can pick, in minutes; the first is the default */
  intervalsMinutes: number[];
  maxAutoRunsPerDay: number;
};

export const PLAN_IDS = ["free", "pro", "internal"] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export const PLANS: Record<
  PlanId,
  { label: string; monthlyPriceUsd: number; limits: UsageLimits; autoScan: AutoScanSettings }
> = {
  free: {
    label: "Free",
    monthlyPriceUsd: 0,
    limits: {
      // ~2 scans a day of 10 accounts, like the first real tests
      monthlyXPostReads: 3_000,
      monthlyScoringUsd: 10,
      monthlyReplyUsd: 3,
      maxActiveWatchlist: 10,
      maxCandidatesPerRun: 60,
    },
    autoScan: { intervalsMinutes: [120, 240, 480], maxAutoRunsPerDay: 12 },
  },
  pro: {
    label: "Pro",
    monthlyPriceUsd: 29,
    limits: {
      monthlyXPostReads: 10_000,
      monthlyScoringUsd: 30,
      monthlyReplyUsd: 10,
      maxActiveWatchlist: 30,
      maxCandidatesPerRun: 100,
    },
    autoScan: { intervalsMinutes: [30, 60, 120], maxAutoRunsPerDay: 48 },
  },
  // Development and dogfooding accounts
  internal: {
    label: "Internal",
    monthlyPriceUsd: 0,
    limits: {
      monthlyXPostReads: 20_000,
      monthlyScoringUsd: 50,
      monthlyReplyUsd: 20,
      maxActiveWatchlist: 50,
      maxCandidatesPerRun: 100,
    },
    autoScan: { intervalsMinutes: [30, 60, 120], maxAutoRunsPerDay: 48 },
  },
};

/** The plan's limits with any per-user overrides on top. */
export function effectiveLimits(
  plan: PlanId,
  overrides: Partial<UsageLimits> | null | undefined,
): UsageLimits {
  return { ...PLANS[plan].limits, ...overrides };
}
