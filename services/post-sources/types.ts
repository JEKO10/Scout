import type { WatchlistAccount } from "@/db/schema";
import type {
  NormalizedCandidatePost,
  NormalizedProfile,
} from "@/lib/posts/types";

export type FetchPostsInput = {
  profileId: string;
  account: Pick<WatchlistAccount, "platformUserId" | "handle">;
  /** Only posts the source got after this moment; null on the first scan */
  since: Date | null;
  limit: number;
};

/**
 * Where a watched account's posts come from. The watchlist only stores who to
 * follow; a source knows how to get their posts. Everything downstream (scan
 * pipeline, scoring, replies) works with NormalizedCandidatePost and never
 * learns which source produced it.
 */
export type PostSource = {
  id: string;
  /** Resolves a handle to a profile, or null when the account doesn't exist. */
  resolveAccount?(handle: string): Promise<NormalizedProfile | null>;
  /** The account's posts, newest first. */
  fetchPosts(input: FetchPostsInput): Promise<NormalizedCandidatePost[]>;
};

/** Thrown when a source can't be used right now (no credentials, no credits). */
export class PostSourceUnavailableError extends Error {
  constructor(
    readonly sourceId: string,
    message: string,
  ) {
    super(message);
    this.name = "PostSourceUnavailableError";
  }
}
