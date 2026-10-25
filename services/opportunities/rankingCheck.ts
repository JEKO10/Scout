import type { ScoutCandidate } from "@/db/schema";

import { shouldSurface } from "./score";

// Day 9 test: the user's blind YES / MAYBE / NO against Scout's ranking.
// Pure: no I/O.

type Candidate = Pick<
  ScoutCandidate,
  "id" | "authorHandle" | "content" | "score" | "shouldEngage" | "reason" | "userLabel"
>;

export type RankingCheck = {
  /** Candidates both scored by Scout and labeled by the user */
  compared: number;
  unlabeled: number;
  unscored: number;
  yes: number;
  surfaced: number;
  /** Of the user's YES, how many Scout surfaced */
  yesSurfaced: number;
  /** Of Scout's surfaced, how many the user said YES or MAYBE to */
  surfacedWanted: number;
  /** How many of the user's YES sit in Scout's top N, N = number of YES */
  yesInTopN: number;
  averageScore: Record<"yes" | "maybe" | "no", number | null>;
  /** YES that Scout didn't surface, and NO that it did */
  missed: Candidate[];
  wrong: Candidate[];
};

const surfaced = (candidate: Candidate) =>
  shouldSurface(candidate.score ?? 0, candidate.shouldEngage ?? false);

export function rankingCheck(candidates: Candidate[]): RankingCheck {
  const scored = candidates.filter((candidate) => candidate.score !== null);
  const both = scored.filter((candidate) => candidate.userLabel !== null);
  const byScore = [...both].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const withLabel = (label: "yes" | "maybe" | "no") =>
    both.filter((candidate) => candidate.userLabel === label);
  const average = (items: Candidate[]) =>
    items.length
      ? Math.round(items.reduce((sum, item) => sum + (item.score ?? 0), 0) / items.length)
      : null;

  const yes = withLabel("yes");
  const topIds = new Set(byScore.slice(0, yes.length).map((candidate) => candidate.id));
  const surfacedItems = both.filter(surfaced);

  return {
    compared: both.length,
    unlabeled: scored.length - both.length,
    unscored: candidates.length - scored.length,
    yes: yes.length,
    surfaced: surfacedItems.length,
    yesSurfaced: yes.filter(surfaced).length,
    surfacedWanted: surfacedItems.filter((candidate) => candidate.userLabel !== "no").length,
    yesInTopN: yes.filter((candidate) => topIds.has(candidate.id)).length,
    averageScore: {
      yes: average(yes),
      maybe: average(withLabel("maybe")),
      no: average(withLabel("no")),
    },
    missed: yes.filter((candidate) => !surfaced(candidate)),
    wrong: withLabel("no").filter(surfaced),
  };
}
