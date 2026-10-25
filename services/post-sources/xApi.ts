import "server-only";

import { getXUserCandidatePosts, XApiRequestError } from "@/lib/x/client";
import { lookupXHandle } from "@/services/x/lookupHandle";

import { type PostSource, PostSourceUnavailableError } from "./types";

// 401 bad token, 402 out of credits, 403 plan doesn't include the endpoint,
// 429 rate limited: X can't answer right now, which says nothing about the account
const UNAVAILABLE_STATUSES = new Set([401, 402, 403, 429]);

function toSourceError(error: unknown): unknown {
  const missingToken =
    error instanceof Error && error.message.includes("X_BEARER_TOKEN");
  if (
    missingToken ||
    (error instanceof XApiRequestError && UNAVAILABLE_STATUSES.has(error.status))
  ) {
    return new PostSourceUnavailableError("x_api", (error as Error).message);
  }
  return error;
}

// satisfies (not a type annotation) keeps resolveAccount known as present
export const xApiSource = {
  id: "x_api",

  async resolveAccount(handle) {
    const result = await lookupXHandle(handle);
    if (result.status === "found") return result.profile;
    if (result.status === "not_found") return null;

    // No status means the request never reached X (no token, network down)
    if (result.httpStatus === null || UNAVAILABLE_STATUSES.has(result.httpStatus)) {
      throw new PostSourceUnavailableError("x_api", result.message);
    }
    throw new Error(`X account lookup failed: ${result.message}`);
  },

  async fetchPosts({ account, since, limit }) {
    try {
      return await getXUserCandidatePosts(account, { limit, since });
    } catch (error) {
      throw toSourceError(error);
    }
  },
} satisfies PostSource;
