export type CandidateFilterReason =
  | "repost"
  | "empty"
  | "too_old"
  | "already_seen"
  // Replies lack the post they answer, so they carry no usable context
  | "reply";

export type ScoutRunStats = {
  accountsTotal: number;
  accountsScanned: number;
  accountsFailed: number;
  postsFetched: number;
  duplicates: number;
  filtered: Record<CandidateFilterReason, number>;
  candidates: number;
  /** Accounts scanned per post source, e.g. { x_api: 3, import: 9 } */
  sources: Record<string, number>;
  failures: { handle: string; reason: string }[];
  /** Day 9 Opportunity Engine; absent on runs from before it existed */
  scoring?: ScoringStats;
};

/** Points per factor; the total score (0–100) is their sum. */
export type OpportunityScoreBreakdown = {
  relevance: number; // 0–25, AI
  goalAlignment: number; // 0–20, AI
  expertiseFit: number; // 0–20, AI
  freshness: number; // 0–15, code
  audienceValue: number; // 0–10, AI
  novelty: number; // 0–10, AI
};

export type ScoringStats = {
  scored: number;
  /** Candidates left unscored after a failed AI batch; the next run retries them */
  unscored: number;
  surfaced: number;
  /** Why scoring was skipped entirely, e.g. no Scout Brain yet */
  skippedReason?: string;
};
