// How many opportunities the user wants: a choice, not a raw score. Each maps
// to the score a post needs to show up in their feed.

export const OPPORTUNITY_SENSITIVITIES = ["fewer", "balanced", "more"] as const;

export type OpportunitySensitivity = (typeof OPPORTUNITY_SENSITIVITIES)[number];

export const SENSITIVITY_INFO: Record<
  OpportunitySensitivity,
  { threshold: number; label: string; hint: string }
> = {
  fewer: { threshold: 70, label: "Fewer", hint: "Only the strongest matches" },
  // Tuned on the first ranking check: the user's YES averaged 60
  balanced: { threshold: 60, label: "Balanced", hint: "Recommended" },
  more: { threshold: 50, label: "More", hint: "Also weaker matches worth a look" },
};

export function surfaceThreshold(sensitivity: OpportunitySensitivity | null | undefined): number {
  return SENSITIVITY_INFO[sensitivity ?? "balanced"].threshold;
}
