import { createHash } from "node:crypto";

// "Did we miss this?" (Day 21): a few posts Scout scored but didn't surface,
// shown for the user to rate. Mostly near the threshold, where a wrong call
// is likely, plus one random lower-scored post so the ratings also measure
// what Scout misses far below it. Pure: no I/O.

export const MISSED_POSTS = {
  perDay: 3,
  /** Of perDay, how many come from near the threshold (the rest: random lower-scored) */
  nearThreshold: 2,
  /** Points below the threshold that still count as "near" */
  nearMargin: 15,
  /** Only recent posts: older conversations have moved on */
  maxAgeDays: 7,
};

export type MissCandidate = {
  id: string;
  score: number;
  shouldEngage: boolean;
  missRatedAt: Date | null;
};

export type MissSample = "near_threshold" | "random_low";

/** Near: within the margin below the threshold, or above it but the model said don't engage. */
export function missSampleKind(candidate: Pick<MissCandidate, "score" | "shouldEngage">, threshold: number): MissSample {
  const near = candidate.score >= threshold - MISSED_POSTS.nearMargin && (candidate.score < threshold || !candidate.shouldEngage);
  return near ? "near_threshold" : "random_low";
}

/** Stable per user and day, so a reload shows the same posts. */
function order(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}:${id}`).digest("hex");
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Today's posts to rate: at most `perDay` minus the ones already rated today.
 * `candidates` are scored, unsurfaced posts of one user (unrated ones, plus
 * any rated today so they count against the daily limit).
 */
export function selectMissedPosts<T extends MissCandidate>(
  candidates: T[],
  { threshold, seed, now = new Date() }: { threshold: number; seed: string; now?: Date },
): (T & { sample: MissSample })[] {
  const today = utcDay(now);
  const ratedToday = candidates.filter((c) => c.missRatedAt && utcDay(c.missRatedAt) === today).length;
  const slots = Math.max(0, MISSED_POSTS.perDay - ratedToday);
  if (slots === 0) return [];

  const daySeed = `${seed}:${today}`;
  const pool = candidates
    .filter((c) => !c.missRatedAt)
    .map((c) => ({ ...c, sample: missSampleKind(c, threshold) }))
    .sort((a, b) => order(daySeed, a.id).localeCompare(order(daySeed, b.id)));
  const near = pool.filter((c) => c.sample === "near_threshold");
  const low = pool.filter((c) => c.sample === "random_low");

  // Near-threshold first (up to its share), the rest random lower-scored
  const nearCount = Math.min(MISSED_POSTS.nearThreshold, near.length, slots);
  const picked = [...near.slice(0, nearCount), ...low.slice(0, slots - nearCount)];
  // If one kind runs short, the other fills the slots
  for (const c of [...near, ...low]) {
    if (picked.length >= slots) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.slice(0, slots);
}
