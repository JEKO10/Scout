import "server-only";

import { getScoutLimits } from "@/lib/scout/testLimits";
import {
  getXUserCandidatePosts,
  XApiBudgetError,
  XApiRequestError,
} from "@/lib/x/client";
import { cursorQuery, nextCursor } from "@/services/scout/xCursor";
import { lookupXHandle } from "@/services/x/lookupHandle";

import { type PostSource, PostSourceUnavailableError } from "./types";

// 401 bad token, 402 out of credits, 403 plan doesn't include the endpoint,
// 429 rate limited: X can't answer right now, which says nothing about the account
const UNAVAILABLE_STATUSES = new Set([401, 402, 403, 429]);

function unavailableMessage(error: XApiRequestError): string {
  if (error.status === 402) return "X API credits are used up (402). Add credits to keep scanning X.";
  if (error.status === 429) return "X API rate limit reached; try again later.";
  return error.message;
}

function toSourceError(error: unknown): unknown {
  if (error instanceof XApiBudgetError) {
    return new PostSourceUnavailableError("x_api", error.message);
  }
  if (error instanceof XApiRequestError && UNAVAILABLE_STATUSES.has(error.status)) {
    return new PostSourceUnavailableError("x_api", unavailableMessage(error));
  }
  if (error instanceof Error && error.message.includes("X_BEARER_TOKEN")) {
    return new PostSourceUnavailableError("x_api", error.message);
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

    // No status means the request never reached X (no token, network down,
    // daily budget used up)
    if (result.httpStatus === null || UNAVAILABLE_STATUSES.has(result.httpStatus)) {
      throw new PostSourceUnavailableError("x_api", result.message);
    }
    throw new Error(`X account lookup failed: ${result.message}`);
  },

  /**
   * Reads forward from the account's cursor by post ID, one page per scan.
   * Replies and reposts are excluded by X itself when the limits say so, so
   * they're never billed; the candidate filters still check each post's kind.
   */
  async fetchPosts({ account, limit, notBefore, usage }) {
    const { fetchReplies } = getScoutLimits();
    try {
      const { posts, hasMore } = await getXUserCandidatePosts(
        account,
        {
          limit,
          ...cursorQuery(account.xCursor),
          startTime: account.xCursor ? undefined : notBefore,
          excludeReplies: !fetchReplies,
        },
        usage,
      );
      return {
        posts,
        nextCursor: nextCursor(
          account.xCursor,
          posts.map((post) => post.platformPostId),
          hasMore,
        ),
      };
    } catch (error) {
      throw toSourceError(error);
    }
  },
} satisfies PostSource;
