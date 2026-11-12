import type { PrefilterReason } from "@/lib/scout/prefilter";
import type { OpportunityScoreBreakdown } from "@/lib/scout/types";
import type {
  CandidateForJudgment,
  RankingBrain,
} from "@/services/opportunities/scoreOpportunity";
import type { ScoringStrategyId } from "@/services/opportunities/scoringStrategy";

// Day 20 scoring evaluation. Datasets and results are local files
// (evals/scoring/*.local.json, git-ignored): they contain Scout Brains and
// must never be committed or shared.

/** One real, previously scored candidate, frozen with everything scoring saw. */
export type EvalExample = {
  /** The scout_candidates id */
  id: string;
  /** "profile-1", "profile-2"…: no user ids or emails in eval files */
  profileKey: string;
  /** Exactly what production sent the model for this post */
  input: CandidateForJudgment;
  /** Freshness points at the original scoring time (code, not AI) */
  freshness: number;
  postedAt: string;
  url: string;
  /** Why it is in the dataset: "high", "medium", "low", "quote", "labeled", "replied"… */
  strata: string[];
  /** What production decided. A reference, not ground truth. */
  original: {
    score: number | null;
    breakdown: OpportunityScoreBreakdown | null;
    shouldEngage: boolean | null;
    reason: string | null;
    suggestedAngle: string | null;
    topic: string | null;
    surfaced: boolean;
    /** Opportunity status when it surfaced: new, saved, dismissed, replied */
    opportunityStatus: string | null;
    /** Day 9 blind label by the user */
    userLabel: "yes" | "maybe" | "no" | null;
  };
};

export type EvalDataset = {
  version: 1;
  exportedAt: string;
  profiles: Record<
    string,
    {
      brain: RankingBrain;
      /** The user's own writing, for the pre-filter's language rule */
      userWriting: string[];
      threshold: number;
    }
  >;
  examples: EvalExample[];
};

export type EvalOutcome = {
  id: string;
  /** AI points + freshness (no learning nudge, so strategies compare like for like) */
  score: number | null;
  shouldEngage: boolean | null;
  surfaced: boolean;
  reason: string | null;
  suggestedAngle: string | null;
  topic: string | null;
  stage: "primary" | "escalation" | null;
  prefiltered: PrefilterReason | null;
};

export type TokenTotals = {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
};

export type EvalRun = {
  /** A production strategy or an evaluation-only variant (variants.ts) */
  strategy: ScoringStrategyId | string;
  /** mock: simulated model and tokens; live: real OpenAI calls */
  mode: "mock" | "live";
  startedAt: string;
  examples: number;
  outcomes: EvalOutcome[];
  calls: number;
  failedCalls: number;
  /** Calls whose output didn't parse into the schema */
  invalidOutputs: number;
  /** Candidates sent but missing from the answer */
  missingJudgments: number;
  escalated: number;
  /** Summed model-call time */
  latencyMs: number;
  tokens: TokenTotals;
  /** Reported usage, plus the worst case of calls whose usage is unknown */
  costUsd: number;
  /** Of costUsd: worst-case amounts for failed calls without reported usage */
  unaccountedUsd: number;
  costByModel: Record<string, number>;
  budgetUsd: number | null;
  /** True when the budget stopped the run before every call was made */
  stoppedByBudget: boolean;
  errors: string[];
};

export const OPPORTUNITY_LABELS = [
  "strong",
  "acceptable",
  "weak",
  "irrelevant",
] as const;
export type OpportunityLabel = (typeof OPPORTUNITY_LABELS)[number];

/** A human reviewer's blind judgments, keyed by example id. */
export type ReviewLabels = Record<
  string,
  {
    label: OpportunityLabel;
    /** Per anonymized output letter (A, B, C…) */
    outputs?: Record<
      string,
      {
        personalized?: boolean;
        angleSpecific?: boolean;
        quoteUnderstood?: boolean;
      }
    >;
  }
>;
