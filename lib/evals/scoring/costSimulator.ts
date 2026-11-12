// Monthly cost model for scoring, replies and X. Every number is an input:
// estimates, not billing data. X does not scale linearly with users: shared
// fetching reads each watched account once, however many users watch it.

export type SimulatorAssumptions = {
  scansPerDay: number;
  /** New candidates per scan reaching scoring (after scan filters) */
  candidatesPerScan: number;
  /** USD per candidate sent to the primary model (from an evaluation run) */
  primaryCostPerCandidate: number;
  /** USD per candidate in the second stage (hybrid only; 0 otherwise) */
  escalationCostPerCandidate: number;
  /** Share of candidates the pre-filter drops before any model call */
  prefilterRate: number;
  /** Share of scored candidates escalated to the second stage */
  escalationRate: number;
  /** Extra calls from failed batches retried on a later run */
  retryRate: number;
  /** Share of scored candidates that become opportunities */
  surfaceRate: number;
  /** Reply generations per user per day, and USD per generation */
  repliesPerDay: number;
  replyCostUsd: number;
  /** X: accounts each user watches, from a shared pool of popular accounts */
  accountsPerUser: number;
  accountPoolSize: number;
  postsPerAccountPerDay: number;
  /** USD per post read (lib/x/pricing.ts) */
  xCostPerPostRead: number;
};

export const DEFAULT_ASSUMPTIONS: SimulatorAssumptions = {
  scansPerDay: 3,
  candidatesPerScan: 15,
  primaryCostPerCandidate: 0.0094,
  escalationCostPerCandidate: 0,
  prefilterRate: 0,
  escalationRate: 0,
  retryRate: 0.02,
  surfaceRate: 0.2,
  repliesPerDay: 2,
  replyCostUsd: 0.028,
  accountsPerUser: 10,
  accountPoolSize: 2000,
  postsPerAccountPerDay: 4,
  xCostPerPostRead: 0.005,
};

export type SimulationRow = {
  users: number;
  scoringUsd: number;
  replyUsd: number;
  xUsd: number;
  /** What X would cost if every user fetched their own accounts */
  xUsdWithoutSharing: number;
  totalUsd: number;
  perUserUsd: number;
  perScoredCandidateUsd: number;
  perOpportunityUsd: number;
};

/** Expected distinct accounts when each user picks `a` of `pool` accounts. */
export function expectedUniqueAccounts(
  users: number,
  a: number,
  pool: number,
): number {
  if (a >= pool) return pool;
  return pool * (1 - (1 - a / pool) ** users);
}

export function simulateMonthlyCost(
  users: number,
  assumptions: SimulatorAssumptions = DEFAULT_ASSUMPTIONS,
): SimulationRow {
  const a = assumptions;
  const candidates = users * a.scansPerDay * a.candidatesPerScan * 30;
  const scored = candidates * (1 - a.prefilterRate);
  const perScored =
    (a.primaryCostPerCandidate +
      a.escalationRate * a.escalationCostPerCandidate) *
    (1 + a.retryRate);
  const scoringUsd = scored * perScored;
  const replyUsd = users * a.repliesPerDay * a.replyCostUsd * 30;
  const reads = (accounts: number) =>
    accounts * a.postsPerAccountPerDay * 30 * a.xCostPerPostRead;
  const xUsd = reads(
    expectedUniqueAccounts(users, a.accountsPerUser, a.accountPoolSize),
  );
  const xUsdWithoutSharing = reads(users * a.accountsPerUser);
  const totalUsd = scoringUsd + replyUsd + xUsd;
  const opportunities = scored * a.surfaceRate;
  return {
    users,
    scoringUsd,
    replyUsd,
    xUsd,
    xUsdWithoutSharing,
    totalUsd,
    perUserUsd: users ? totalUsd / users : 0,
    perScoredCandidateUsd: scored ? scoringUsd / scored : 0,
    perOpportunityUsd: opportunities ? scoringUsd / opportunities : 0,
  };
}

export function simulationTable(rows: SimulationRow[], title: string): string {
  const usd = (value: number) =>
    value < 10
      ? `$${value.toFixed(2)}`
      : `$${Math.round(value).toLocaleString("en")}`;
  return [
    `**${title}** (estimates, not billing data)`,
    "",
    "| Users | AI scoring | AI replies | X (shared fetch) | X without sharing | Total / month | Per user | Scoring per candidate | Scoring per opportunity |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(
      (row) =>
        `| ${row.users.toLocaleString("en")} | ${usd(row.scoringUsd)} | ${usd(row.replyUsd)} | ${usd(row.xUsd)} | ${usd(row.xUsdWithoutSharing)} | ${usd(row.totalUsd)} | ${usd(row.perUserUsd)} | $${row.perScoredCandidateUsd.toFixed(4)} | $${row.perOpportunityUsd.toFixed(4)} |`,
    ),
  ].join("\n");
}
