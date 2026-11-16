// Subscription plans and their usage limits, in one place. Scout enforces
// them server-side; Paddle only decides which plan a user has.
//
// Day 23 beta limits, sized from measured costs (X $0.005 per post read,
// ~$0.0104 per scored post, ~$0.028 per reply generation) so that a user
// who uses everything stays well under the plan's price, and paced daily so
// the allowance lasts the whole month (see services/billing/budget.ts).

export type UsageLimits = {
  /** X post resources read per calendar month (UTC), quoted posts included */
  monthlyXPostReads: number;
  /** Estimated OpenAI spend on opportunity scoring per month, USD */
  monthlyScoringUsd: number;
  /** Estimated OpenAI spend on reply generation per month, USD (not paced: replies are on demand) */
  monthlyReplyUsd: number;
  maxActiveWatchlist: number;
  /** Candidates the AI scores in one run; the rest wait for the next run */
  maxCandidatesPerRun: number;
  /**
   * X reads and AI scoring become available day by day (a starting share up
   * front, the rest accruing through the month, unused carrying forward)
   * instead of all on the 1st.
   */
  dailyPacing: boolean;
  /**
   * Day 26 Smart Discovery topics that can be active. Searches share the
   * plan's X and AI budgets with the watchlist: no separate allowance.
   */
  maxDiscoveryTopics: number;
};

/** Automatic Scout (Day 18): how often a plan may scan on its own. */
export type AutoScanSettings = {
  /** Intervals the user can pick, in minutes; the first is the default */
  intervalsMinutes: number[];
  maxAutoRunsPerDay: number;
};

// Order matters for the Postgres enum: new plans are inserted, never reordered
export const PLAN_IDS = ["free", "starter", "pro", "internal"] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export const PLANS: Record<
  PlanId,
  { label: string; monthlyPriceUsd: number; limits: UsageLimits; autoScan: AutoScanSettings }
> = {
  // Max direct cost ~$1.20/month: 100 reads ($0.50) + $0.50 scoring + $0.20 replies
  free: {
    label: "Free",
    monthlyPriceUsd: 0,
    limits: {
      monthlyXPostReads: 100,
      monthlyScoringUsd: 0.5,
      monthlyReplyUsd: 0.2,
      maxActiveWatchlist: 3,
      maxCandidatesPerRun: 20,
      dailyPacing: true,
      maxDiscoveryTopics: 1,
    },
    // ~3 new posts a day to read: one daily scan is enough
    autoScan: { intervalsMinutes: [1440], maxAutoRunsPerDay: 1 },
  },
  // Max ~$6/month: 600 reads ($3) + $2.50 scoring + $0.50 replies
  starter: {
    label: "Starter",
    monthlyPriceUsd: 12,
    limits: {
      monthlyXPostReads: 600,
      monthlyScoringUsd: 2.5,
      monthlyReplyUsd: 0.5,
      maxActiveWatchlist: 8,
      maxCandidatesPerRun: 40,
      dailyPacing: true,
      maxDiscoveryTopics: 3,
    },
    autoScan: { intervalsMinutes: [720, 1440], maxAutoRunsPerDay: 2 },
  },
  // Max ~$15.50/month: 1,500 reads ($7.50) + $5 scoring + $3 replies
  pro: {
    label: "Pro",
    monthlyPriceUsd: 24,
    limits: {
      monthlyXPostReads: 1_500,
      monthlyScoringUsd: 5,
      monthlyReplyUsd: 3,
      maxActiveWatchlist: 15,
      maxCandidatesPerRun: 60,
      dailyPacing: true,
      maxDiscoveryTopics: 5,
    },
    // 15 accounts x 4 scans = at most ~60 X requests a day
    autoScan: { intervalsMinutes: [360, 720, 1440], maxAutoRunsPerDay: 4 },
  },
  // Development and dogfooding accounts: never billed, not paced
  internal: {
    label: "Internal",
    monthlyPriceUsd: 0,
    limits: {
      monthlyXPostReads: 20_000,
      monthlyScoringUsd: 50,
      monthlyReplyUsd: 20,
      maxActiveWatchlist: 50,
      maxCandidatesPerRun: 100,
      dailyPacing: false,
      maxDiscoveryTopics: 10,
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
