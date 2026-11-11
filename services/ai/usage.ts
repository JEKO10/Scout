import "server-only";

import type { ResponseUsage } from "openai/resources/responses/responses";

import { insertAiUsage } from "@/db/queries/aiUsage";
import type { AiOperation } from "@/db/schema";
import { estimateCostUsd } from "@/lib/ai/pricing";

/** Who an OpenAI call was for, and what it was for. */
export type AiUsageContext = {
  profileId: string;
  operation: AiOperation;
  scoutRunId?: string | null;
};

/**
 * Records one OpenAI call from the usage the API returned. Never throws:
 * losing a usage row must not fail the scan or reply that just succeeded.
 */
export async function recordAiUsage(
  context: AiUsageContext,
  response: { model: string; usage?: ResponseUsage | null },
): Promise<void> {
  const usage = response.usage;
  if (!usage) {
    console.warn("OpenAI response without usage", context.operation, response.model);
    return;
  }
  const tokens = {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
  try {
    await insertAiUsage({
      profileId: context.profileId,
      scoutRunId: context.scoutRunId ?? null,
      operation: context.operation,
      model: response.model,
      ...tokens,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
      costUsd: estimateCostUsd(response.model, tokens),
    });
  } catch (error) {
    console.error("Recording AI usage failed", context.operation, error);
  }
}
