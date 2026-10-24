"use server";

import { refresh } from "next/cache";
import OpenAI from "openai";
import { z } from "zod";

import {
  createEvalCases,
  deleteEvalCase,
  getEvalCases,
  rateEvalResult,
} from "@/db/queries/eval";
import { requireProfile } from "@/lib/auth/session";
import { runBrainEval } from "@/services/brain-eval/runEval";
import { SAMPLE_EVAL_CASES } from "@/services/brain-eval/sampleCases";

export type EvalActionState = {
  status: "idle" | "success" | "error";
  message?: string;
};

export async function runEvalAction(): Promise<EvalActionState> {
  const { profile } = await requireProfile();

  try {
    const result = await runBrainEval(profile.id);
    if (result.status === "no_brain") {
      return { status: "error", message: "Analyze your profile first." };
    }
    if (result.status === "no_cases") {
      return { status: "error", message: "Add test posts first." };
    }
    refresh();
    return {
      status: "success",
      message: `Generated ${result.caseCount} decisions and replies.`,
    };
  } catch (error) {
    console.error("Brain eval failed", error);
    return {
      status: "error",
      message:
        error instanceof OpenAI.APIError && error.status === 429
          ? "The AI service is rate limiting us. Try again shortly."
          : "Eval failed. Try again in a moment.",
    };
  }
}

export async function addSampleCasesAction(): Promise<EvalActionState> {
  const { profile } = await requireProfile();
  if ((await getEvalCases(profile.id)).length > 0) {
    return { status: "error", message: "You already have test posts." };
  }
  await createEvalCases(profile.id, SAMPLE_EVAL_CASES);
  refresh();
  return { status: "success" };
}

const caseSchema = z.object({
  authorHandle: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@+/, ""))
    .pipe(z.string().min(1, "Add the author's handle.").max(50)),
  content: z.string().trim().min(1, "Paste the post text.").max(4000),
  category: z.enum([
    "very_relevant",
    "somewhat_relevant",
    "knows_little_to_add",
    "irrelevant",
  ]),
});

export async function addEvalCaseAction(
  _prev: EvalActionState,
  formData: FormData,
): Promise<EvalActionState> {
  const { profile } = await requireProfile();
  const parsed = caseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message };
  }
  await createEvalCases(profile.id, [parsed.data]);
  refresh();
  return { status: "success", message: "Test post added." };
}

export async function deleteEvalCaseAction(caseId: string): Promise<void> {
  const { profile } = await requireProfile();
  await deleteEvalCase(profile.id, z.uuid().parse(caseId));
  refresh();
}

const ratingSchema = z.object({
  resultId: z.uuid(),
  voiceScore: z.number().int().min(1).max(5),
  wouldPost: z.boolean(),
  tooGeneric: z.boolean(),
  decisionCorrect: z.boolean(),
  notes: z
    .string()
    .trim()
    .max(2000)
    .transform((value) => value || null),
});

export type EvalRatingInput = z.input<typeof ratingSchema>;

export async function rateEvalResultAction(
  input: EvalRatingInput,
): Promise<EvalActionState> {
  const { profile } = await requireProfile();
  const parsed = ratingSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Answer every question before saving." };
  }

  const { resultId, ...rating } = parsed.data;
  const saved = await rateEvalResult(profile.id, resultId, rating);
  if (!saved) return { status: "error", message: "Result not found." };

  refresh();
  return { status: "success" };
}
