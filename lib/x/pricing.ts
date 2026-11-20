// X API pay-per-use prices in USD, the one place to update them. Estimates:
// X bills per resource returned (reads) or per request (writes); the X
// Developer Console is the truth. Source: docs.x.com/x-api/getting-started/pricing
// and the changelog entry of 2026-04-16 (checked 2026-11-19).

export const X_PRICING = {
  /** Each post returned, quoted/expanded posts included */
  postRead: 0.005,
  /** Each user profile returned (account lookups) */
  userRead: 0.01,
  /** Day 40: POST /2/tweets ("Post: Create") */
  postCreate: 0.015,
  /** POST /2/tweets for a post containing a URL ("Post: Create (with URL)") */
  postCreateWithUrl: 0.2,
  /**
   * DELETE /2/tweets/:id. Not named on the pricing page; reserved at the
   * "Interaction: Delete" rate as the most likely price.
   */
  postDelete: 0.01,
};

export function estimateXCostUsd(usage: { postReads: number; userReads: number }): number {
  return usage.postReads * X_PRICING.postRead + usage.userReads * X_PRICING.userRead;
}
