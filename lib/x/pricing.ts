// X API pay-per-use prices in USD, the one place to update them. Estimates:
// X bills per resource returned; the X developer console is the truth.
// Source: third-party guides citing docs.x.com (checked 2026-11-11), not yet
// confirmed on X's own pricing page.

export const X_PRICING = {
  /** Each post returned, quoted/expanded posts included */
  postRead: 0.005,
  /** Each user profile returned (account lookups) */
  userRead: 0.01,
};

export function estimateXCostUsd(usage: { postReads: number; userReads: number }): number {
  return usage.postReads * X_PRICING.postRead + usage.userReads * X_PRICING.userRead;
}
