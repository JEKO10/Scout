import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";

import db from "@/db";
import {
  type EvalCase,
  evalCasesTable,
  type EvalResult,
  evalResultsTable,
  type EvalRun,
  evalRunsTable,
} from "@/db/schema";
import type { EngagementDecision } from "@/lib/ai/schemas/brainEval";

export async function getEvalCases(profileId: string): Promise<EvalCase[]> {
  return db
    .select()
    .from(evalCasesTable)
    .where(eq(evalCasesTable.profileId, profileId))
    .orderBy(asc(evalCasesTable.createdAt));
}

export async function createEvalCases(
  profileId: string,
  cases: Pick<EvalCase, "authorHandle" | "content" | "category">[],
): Promise<void> {
  if (cases.length === 0) return;
  await db
    .insert(evalCasesTable)
    .values(cases.map((evalCase) => ({ profileId, ...evalCase })));
}

/** Scoped by profile so one user can never delete another user's case. */
export async function deleteEvalCase(
  profileId: string,
  caseId: string,
): Promise<void> {
  await db
    .delete(evalCasesTable)
    .where(
      and(eq(evalCasesTable.id, caseId), eq(evalCasesTable.profileId, profileId)),
    );
}

export async function createEvalRun(
  profileId: string,
  {
    brainAnalyzedAt,
    model,
    results,
  }: {
    brainAnalyzedAt: Date;
    model: string;
    results: {
      caseId: string;
      decision: EngagementDecision;
      reply: string;
      contextPostIds: string[];
    }[];
  },
): Promise<EvalRun> {
  const [run] = await db
    .insert(evalRunsTable)
    .values({ profileId, brainAnalyzedAt, model })
    .returning();
  await db
    .insert(evalResultsTable)
    .values(results.map((result) => ({ runId: run.id, ...result })));
  return run;
}

export type EvalRunWithResults = EvalRun & {
  results: (EvalResult & { evalCase: EvalCase })[];
};

/** All runs for a profile, newest first, each with its results in case order. */
export async function getEvalRuns(
  profileId: string,
): Promise<EvalRunWithResults[]> {
  const rows = await db
    .select({
      run: evalRunsTable,
      result: evalResultsTable,
      evalCase: evalCasesTable,
    })
    .from(evalRunsTable)
    .innerJoin(evalResultsTable, eq(evalResultsTable.runId, evalRunsTable.id))
    .innerJoin(evalCasesTable, eq(evalResultsTable.caseId, evalCasesTable.id))
    .where(eq(evalRunsTable.profileId, profileId))
    .orderBy(desc(evalRunsTable.createdAt), asc(evalCasesTable.createdAt));

  const runs = new Map<string, EvalRunWithResults>();
  for (const { run, result, evalCase } of rows) {
    const entry = runs.get(run.id) ?? { ...run, results: [] };
    entry.results.push({ ...result, evalCase });
    runs.set(run.id, entry);
  }
  return [...runs.values()];
}

export type EvalRating = Pick<
  EvalResult,
  "voiceScore" | "wouldPost" | "tooGeneric" | "decisionCorrect" | "notes"
>;

/** Saves the user's rating; the join on runs keeps it scoped to the profile. */
export async function rateEvalResult(
  profileId: string,
  resultId: string,
  rating: EvalRating,
): Promise<boolean> {
  const [owned] = await db
    .select({ id: evalResultsTable.id })
    .from(evalResultsTable)
    .innerJoin(evalRunsTable, eq(evalResultsTable.runId, evalRunsTable.id))
    .where(
      and(
        eq(evalResultsTable.id, resultId),
        eq(evalRunsTable.profileId, profileId),
      ),
    );
  if (!owned) return false;

  await db
    .update(evalResultsTable)
    .set({ ...rating, ratedAt: new Date() })
    .where(eq(evalResultsTable.id, resultId));
  return true;
}
