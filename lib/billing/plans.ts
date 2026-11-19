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
  /**
   * Day 27 Lead Scout: posts checked for buying intent per scan, the most
   * relevant first. Paid from the scoring budget, so it never adds cost on top.
   */
  maxLeadChecksPerRun: number;
  /** Day 28: leads kept in the CRM at once (stored data only: no API cost) */
  maxSavedLeads: number;
  /** Day 30: AI trend insights generated per day (on request, cached); paid from the scoring budget */
  maxTrendInsightsPerDay: number;
  /**
   * Day 34: AI Growth Strategist plans per calendar month (UTC), on request
   * and cached; ~$0.10 each, paid from the scoring budget (approved 2026-11-17).
   */
  maxStrategyGenerationsPerMonth: number;
  /**
   * Day 35 Peer Intelligence: accounts saved for comparison (one X user
   * read each when added, ~$0.01). Approved 2026-11-18.
   */
  maxSavedPeers: number;
  /**
   * Day 35: live peer refreshes per month (up to 20 posts each, paid from
   * the plan's monthly X reads). Off everywhere until PEER_REFRESH_ENABLED
   * is enabled (approved as configuration 2026-11-18; refreshes stay off).
   */
  maxPeerRefreshesPerMonth: number;
  /** Day 36 Automation Scout: automations that can be enabled at once (approved 2026-11-18). */
  maxActiveAutomations: number;
  /**
   * Day 36: automation runs per calendar month (UTC). A run counts once when
   * an event met the automation's conditions and its actions were attempted;
   * skipped events, duplicates and retries don't count (approved 2026-11-18).
   */
  maxAutomationRunsPerMonth: number;
  /**
   * Day 37: posts read in the one-time history import after connecting X
   * (last 29 days, private metrics; from the plan's monthly X reads, $0.005
   * each; never more than the reads left). Approved 2026-11-18.
   */
  maxInitialImportPosts: number;
  /**
   * Day 38 automatic Inbox preparation (approved 2026-11-19; stays off until
   * INBOX_AUTO_PREPARE_ENABLED=true and the user opts in). Ceilings, not
   * promises: posts and reply sets Scout may prepare on its own per window
   * (UTC day, week from Monday, or calendar month).
   */
  autoPrepareWindow: "day" | "week" | "month";
  maxAutoPosts: number;
  maxAutoReplySets: number;
  /** Hard monthly ceiling on automatic AI spending (worst-case reservations), USD */
  maxAutoPrepareUsdPerMonth: number;
  /** Writing budget automatic preparation never touches: kept for what the user asks for, USD */
  reservedManualWritingUsd: number;
  /** Day 38: AI edits and regenerations per UTC day (each also needs writing budget) */
  maxInboxRevisionsPerDay: number;
};

/** Automatic Scout (Day 18): how often a plan may scan on its own. */
export type AutoScanSettings = {
  /** Intervals the user can pick, in minutes; the first is the default */
  intervalsMinutes: number[];
  maxAutoRunsPerDay: number;
};

/**
 * Growth Intelligence with X connected (OAuth): how often Scout re-reads the
 * user's own recent posts on its own. null: manual refresh only. Every
 * collection is paid from the plan's monthly X reads (no extra allowance).
 */
export type GrowthCollectionSettings = { autoEveryHours: number | null };

// Order matters for the Postgres enum: new plans are inserted, never reordered
export const PLAN_IDS = ["free", "starter", "pro", "internal"] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export const PLANS: Record<
  PlanId,
  {
    label: string;
    monthlyPriceUsd: number;
    limits: UsageLimits;
    autoScan: AutoScanSettings;
    growthCollection: GrowthCollectionSettings;
  }
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
      maxLeadChecksPerRun: 3,
      maxSavedLeads: 25,
      maxTrendInsightsPerDay: 2,
      maxStrategyGenerationsPerMonth: 1,
      maxSavedPeers: 3,
      maxPeerRefreshesPerMonth: 0,
      maxActiveAutomations: 1,
      maxAutomationRunsPerMonth: 25,
      maxInitialImportPosts: 25,
      autoPrepareWindow: "month",
      maxAutoPosts: 2,
      maxAutoReplySets: 0,
      maxAutoPrepareUsdPerMonth: 0.05,
      reservedManualWritingUsd: 0.15,
      maxInboxRevisionsPerDay: 10,
    },
    // ~3 new posts a day to read: one daily scan is enough
    autoScan: { intervalsMinutes: [1440], maxAutoRunsPerDay: 1 },
    // Manual refresh only
    growthCollection: { autoEveryHours: null },
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
      maxLeadChecksPerRun: 5,
      maxSavedLeads: 250,
      maxTrendInsightsPerDay: 5,
      maxStrategyGenerationsPerMonth: 4,
      maxSavedPeers: 10,
      maxPeerRefreshesPerMonth: 4,
      maxActiveAutomations: 5,
      maxAutomationRunsPerMonth: 250,
      maxInitialImportPosts: 50,
      autoPrepareWindow: "week",
      maxAutoPosts: 3,
      maxAutoReplySets: 3,
      maxAutoPrepareUsdPerMonth: 0.3,
      reservedManualWritingUsd: 0.2,
      maxInboxRevisionsPerDay: 25,
    },
    autoScan: { intervalsMinutes: [720, 1440], maxAutoRunsPerDay: 2 },
    // Weekly: ~4 collections x 20 posts = ~86 of the 600 monthly reads
    growthCollection: { autoEveryHours: 168 },
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
      maxLeadChecksPerRun: 10,
      maxSavedLeads: 1000,
      maxTrendInsightsPerDay: 10,
      maxStrategyGenerationsPerMonth: 8,
      maxSavedPeers: 20,
      maxPeerRefreshesPerMonth: 8,
      maxActiveAutomations: 15,
      maxAutomationRunsPerMonth: 1000,
      maxInitialImportPosts: 100,
      autoPrepareWindow: "day",
      maxAutoPosts: 1,
      maxAutoReplySets: 2,
      maxAutoPrepareUsdPerMonth: 1.8,
      reservedManualWritingUsd: 1.2,
      maxInboxRevisionsPerDay: 50,
    },
    // 15 accounts x 4 scans = at most ~60 X requests a day
    autoScan: { intervalsMinutes: [360, 720, 1440], maxAutoRunsPerDay: 4 },
    // Every 3 days: ~10 collections x 20 posts = ~200 of the 1,500 monthly reads
    growthCollection: { autoEveryHours: 72 },
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
      maxLeadChecksPerRun: 20,
      maxSavedLeads: 5000,
      maxTrendInsightsPerDay: 30,
      maxStrategyGenerationsPerMonth: 60,
      maxSavedPeers: 50,
      maxPeerRefreshesPerMonth: 40,
      maxActiveAutomations: 50,
      maxAutomationRunsPerMonth: 5000,
      maxInitialImportPosts: 100,
      autoPrepareWindow: "day",
      maxAutoPosts: 2,
      maxAutoReplySets: 4,
      maxAutoPrepareUsdPerMonth: 5,
      reservedManualWritingUsd: 15,
      maxInboxRevisionsPerDay: 200,
    },
    autoScan: { intervalsMinutes: [30, 60, 120], maxAutoRunsPerDay: 48 },
    growthCollection: { autoEveryHours: 24 },
  },
};

/** The plan's limits with any per-user overrides on top. */
export function effectiveLimits(
  plan: PlanId,
  overrides: Partial<UsageLimits> | null | undefined,
): UsageLimits {
  return { ...PLANS[plan].limits, ...overrides };
}
