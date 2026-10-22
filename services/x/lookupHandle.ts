import "server-only";

import { cacheLife } from "next/cache";

import { getXUserByHandle } from "@/lib/x/client";
import type { NormalizedProfile } from "@/lib/x/types";

/**
 * Cached handle → X profile lookup for the handle picker. Every lookup is
 * billed, and profiles rarely change, so results are shared across users for
 * hours. Thrown errors (rate limits, outages) are never cached.
 */
export async function lookupXHandle(
  handle: string,
): Promise<NormalizedProfile | null> {
  "use cache";
  cacheLife("hours");

  return getXUserByHandle(handle.toLowerCase());
}
