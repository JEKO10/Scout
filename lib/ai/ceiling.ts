// Day 38: the most one OpenAI call can cost, known before it is made. Used to
// reserve automatic spending against a hard cap; never an average.
//
// Input: a token is at least one byte of UTF-8 text, so the prompt's byte
// length bounds its input tokens (cached input is cheaper, never dearer).
// Output: max_output_tokens bounds output tokens, reasoning included.
// Prices are OpenAI list prices (lib/ai/pricing.ts); OpenAI's bill is the truth.

import { pricingFor } from "./pricing";

const encoder = new TextEncoder();

/** Worst-case USD for one call, or null when the model has no configured price (then: don't call) */
export function costCeilingUsd(model: string, promptParts: string[], maxOutputTokens: number): number | null {
  const price = pricingFor(model);
  if (!price) return null;
  const inputBytes = promptParts.reduce((sum, part) => sum + encoder.encode(part).length, 0);
  return (inputBytes * price.input + maxOutputTokens * price.output) / 1_000_000;
}

/**
 * Limits for an automatic (not user-initiated) call: a smaller output cap,
 * low reasoning effort, and a gate that reserves the call's ceiling first.
 * The gate throws to stop the call before anything is spent.
 */
export type AutoCallLimits = {
  maxOutputTokens: number;
  gate: (ceilingUsd: number | null) => Promise<void>;
};

/** Thrown by a gate: the call would go over a cap, so it isn't made */
export class AutoBudgetRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AutoBudgetRefused";
  }
}
