import type { NormalizedCandidatePost } from "@/lib/posts/types";
import type { CandidateFilterReason } from "@/lib/scout/types";

// Day 8 only asks "is this a valid candidate at all?" Relevance to the user is
// the Day 9 Opportunity Engine's job.

export const MAX_POST_AGE_DAYS = 7;

const LEADING_MENTIONS = /^(\s*@\w+)+\s*/;
const URLS = /https?:\/\/\S+/g;

const ownText = (post: NormalizedCandidatePost) =>
  post.content.replace(LEADING_MENTIONS, "").replace(URLS, "").trim();

/** Keeps the first occurrence of each post; the same post can come twice. */
export function dedupePosts<T extends NormalizedCandidatePost>(
  posts: T[],
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique = posts.filter((post) => {
    const key = `${post.platform}:${post.platformPostId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { unique, duplicates: posts.length - unique.length };
}

export function rejectionReason(
  post: NormalizedCandidatePost,
  { now, alreadySeen }: { now: Date; alreadySeen: Set<string> },
): CandidateFilterReason | null {
  if (alreadySeen.has(post.platformPostId)) return "already_seen";
  if (post.kind === "repost") return "repost";
  // MVP: a reply only shows one side of a conversation; the post it answers
  // would cost an extra API call and isn't in imports. Quotes include theirs.
  if (post.kind === "reply") return "reply";

  const text = ownText(post);
  if (text.length === 0) return "empty";

  const ageDays = (now.getTime() - post.postedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_POST_AGE_DAYS) return "too_old";
  return null;
}

export function filterCandidates<T extends NormalizedCandidatePost>(
  posts: T[],
  context: { now: Date; alreadySeen: Set<string> },
): { candidates: T[]; filtered: Record<CandidateFilterReason, number> } {
  const filtered: Record<CandidateFilterReason, number> = {
    already_seen: 0,
    repost: 0,
    empty: 0,
    too_old: 0,
    reply: 0,
  };
  const candidates = posts.filter((post) => {
    const reason = rejectionReason(post, context);
    if (reason) filtered[reason]++;
    return reason === null;
  });
  return { candidates, filtered };
}
