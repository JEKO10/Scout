export type CandidateFilterReason =
  | "repost"
  | "empty"
  | "too_old"
  | "already_seen"
  // Replies lack the post they answer, so they carry no usable context
  | "reply"
  // A quote whose quoted post the source didn't include
  | "quote_without_context";

/**
 * Where an account's X timeline was read up to, by post ID. Every post with an
 * ID ≤ sinceId is handled. With untilId set there is a gap: posts between
 * sinceId and untilId are still unread (more arrived than one scan reads), and
 * newestId is the newest post already handled.
 */
export type XScanCursor = {
  sinceId: string;
  untilId?: string;
  newestId?: string;
};

/** X API usage of one run; requests include failed attempts and retries. */
export type XRunUsage = {
  requests: number;
  failed: number;
  retried: number;
  /** Post resources X returned and billed, quoted/expanded posts included */
  postsReturned: number;
  /** Of postsReturned: quoted/expanded posts (absent on older runs) */
  includedReturned?: number;
  /** Account lookups to verify watchlist entries (absent on older runs) */
  userLookups?: number;
  /** Why the run stopped calling X, e.g. out of credits; later accounts used imports */
  stoppedReason?: string;
};

/** Why a run was refused before it started, or a reply wasn't generated. */
export type BudgetExhausted = "x_reads" | "scoring" | "replies";

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
  /** Real X API usage this run caused; absent on runs from before usage tracking */
  xApi?: XRunUsage;
  /**
   * Day 17: X post resources delivered to this user from the shared cache
   * (a quote with its quoted post counts 2). What the plan's monthly X budget
   * is charged for, whoever fetched the posts. Absent on older runs, where
   * xApi.postsReturned was charged instead.
   */
  planXReads?: number;
  /** Day 17: accounts whose shared cache this run refreshed, or reused as fresh */
  sharedFetch?: { fetched: number; reused: number };
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
  /** Day 13: learned nudge, -10 to +10, applied after the base score */
  learning?: number;
  /** Why the learning nudge happened, e.g. "+4 you often engage with AI coding" */
  learningNotes?: string[];
};

export type ScoringStats = {
  scored: number;
  /** Candidates left unscored after a failed AI batch; the next run retries them */
  unscored: number;
  surfaced: number;
  /** Why scoring was skipped entirely, e.g. no Scout Brain yet */
  skippedReason?: string;
};
