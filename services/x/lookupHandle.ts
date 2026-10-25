import "server-only";

import { cacheLife } from "next/cache";

import type { NormalizedProfile } from "@/lib/posts/types";
import { getXUserByHandle, XApiRequestError } from "@/lib/x/client";

export type XHandleLookupResult =
  | { status: "found"; profile: NormalizedProfile }
  | { status: "not_found" }
  /** httpStatus is null when the request never reached X (e.g. no token) */
  | { status: "error"; httpStatus: number | null; message: string };

/**
 * Cached handle → X profile lookup. Every lookup is billed and profiles rarely
 * change, so answers are shared across users for hours.
 *
 * Failures are returned, not thrown: an error thrown inside "use cache" loses
 * its class and status on the way out, so callers couldn't tell "out of
 * credits" from a bug. They're cached only for seconds.
 */
export async function lookupXHandle(
  handle: string,
): Promise<XHandleLookupResult> {
  "use cache";

  try {
    const profile = await getXUserByHandle(handle.toLowerCase());
    cacheLife("hours");
    return profile ? { status: "found", profile } : { status: "not_found" };
  } catch (error) {
    cacheLife("seconds");
    return {
      status: "error",
      httpStatus: error instanceof XApiRequestError ? error.status : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
