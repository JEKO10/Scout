// OpenAI list prices in USD per 1M tokens: the one place to update them.
// Costs computed from these are estimates; OpenAI's billing is the truth.
// Source: developers.openai.com/api/docs/models/gpt-5.5 (checked 2026-11-09).

export type ModelPricing = {
  input: number;
  /** Input tokens served from OpenAI's prompt cache */
  cachedInput: number;
  /** Output tokens, reasoning tokens included */
  output: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  // Listed so "gpt-5.5-pro" never falls back to gpt-5.5's much lower price
  "gpt-5.5-pro": { input: 30, cachedInput: 30, output: 180 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
};

/**
 * Pricing for a model as the API reports it, e.g. "gpt-5.5-2026-04-23" →
 * "gpt-5.5". The longest matching name wins. Null for an unpriced model.
 */
export function pricingFor(model: string): ModelPricing | null {
  const name = Object.keys(MODEL_PRICING)
    .filter((key) => model === key || model.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return name ? MODEL_PRICING[name] : null;
}

export type TokenUsage = {
  /** All input tokens, cached ones included (as the API reports them) */
  inputTokens: number;
  cachedInputTokens: number;
  /** All output tokens, reasoning ones included */
  outputTokens: number;
};

/** Estimated USD cost, or null when the model has no configured price. */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = pricingFor(model);
  if (!price) return null;
  const uncachedInput = usage.inputTokens - usage.cachedInputTokens;
  return (
    (uncachedInput * price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
