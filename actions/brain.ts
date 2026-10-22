"use server";

import { refresh } from "next/cache";
import OpenAI from "openai";
import { z } from "zod";

import { updateBrainListEdit } from "@/db/queries/profiles";
import { editableBrainLists } from "@/lib/ai/schemas/scoutBrain";
import { requireProfile } from "@/lib/auth/session";
import { analyzeUser } from "@/services/scout-brain/analyzeUser";

export type BrainActionState = {
  status: "idle" | "success" | "error";
  message?: string;
};

export async function analyzeBrainAction(): Promise<BrainActionState> {
  const { profile } = await requireProfile();

  try {
    const result = await analyzeUser(profile.id);
    if (result.status === "not_enough_posts") {
      return {
        status: "error",
        message: `Scout needs at least a few posts to learn from (found ${result.postCount}). Sync your X account first.`,
      };
    }

    refresh();
    return {
      status: "success",
      message: `Analyzed ${result.postCount} posts.`,
    };
  } catch (error) {
    console.error("Scout Brain analysis failed", error);
    if (error instanceof OpenAI.APIError && error.status === 429) {
      return {
        status: "error",
        message: "The AI service is busy or out of credits. Try again shortly.",
      };
    }
    return {
      status: "error",
      message: "Analysis failed. Try again in a moment.",
    };
  }
}

const editSchema = z
  .object({
    brain: z.enum(["voice", "interests", "goals"]),
    list: z.string(),
    op: z.enum(["add", "remove"]),
    value: z.string().trim().min(1).max(80),
  })
  .refine(
    ({ brain, list }) =>
      (editableBrainLists[brain] as readonly string[]).includes(list),
    "This part of the Scout Brain can't be edited.",
  );

export type BrainEdit = z.input<typeof editSchema>;

export async function editBrainAction(
  edit: BrainEdit,
): Promise<BrainActionState> {
  const { profile } = await requireProfile();

  const parsed = editSchema.safeParse(edit);
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid edit.",
    };
  }

  const { brain, list, op, value } = parsed.data;
  await updateBrainListEdit(profile.id, brain, list, op, value);
  refresh();
  return { status: "success" };
}
