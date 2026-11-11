"use server";

import { refresh } from "next/cache";
import OpenAI from "openai";
import { z } from "zod";

import { updateBrainListEdit } from "@/db/queries/profiles";
import { addOpinionSample, deleteVoiceSample } from "@/db/queries/voiceSamples";
import { editableBrainLists } from "@/lib/ai/schemas/scoutBrain";
import { requireProfile } from "@/lib/auth/session";
import { analyzeUser } from "@/services/scout-brain/analyzeUser";
import { buildColdStartBrain } from "@/services/scout-brain/buildColdStartBrain";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

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
      message: `Analyzed ${result.postCount} posts · ${result.holdoutCount} held out for evaluation.`,
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

const opinionSchema = z.object({
  prompt: z.string().trim().max(200),
  opinion: z
    .string()
    .trim()
    .min(10, "Write at least a sentence.")
    .max(500, "Keep it under 500 characters."),
});

/** "Teach Scout more": a take in their own words, used at the next rebuild. */
export async function addOpinionAction(
  _prev: BrainActionState,
  formData: FormData,
): Promise<BrainActionState> {
  const { profile } = await requireProfile();
  const parsed = opinionSchema.safeParse({
    prompt: String(formData.get("prompt") ?? ""),
    opinion: String(formData.get("opinion") ?? ""),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Check your opinion." };
  }
  await addOpinionSample(profile.id, parsed.data.prompt || "Their own take", parsed.data.opinion);
  refresh();
  return { status: "success", message: "Saved. Rebuild your Brain to use it." };
}

export async function removeOpinionAction(sampleId: string): Promise<void> {
  const { profile } = await requireProfile();
  await deleteVoiceSample(profile.id, z.uuid().parse(sampleId));
  refresh();
}

/**
 * Rebuilds a Brain built without posts from everything the user has written
 * since: calibration, opinions and the replies they posted. One AI call.
 */
export async function rebuildBrainAction(): Promise<BrainActionState> {
  const { profile } = await requireProfile();
  // A Brain learned from X posts is re-analyzed from posts instead
  if (resolveScoutBrain(profile)?.basis === "posts") {
    return { status: "error", message: "Your Brain is learned from your posts. Use Re-analyze." };
  }
  try {
    const result = await buildColdStartBrain(profile.id);
    refresh();
    return {
      status: "success",
      message: `Rebuilt from ${result.sampleCount} calibration replies, ${result.opinionCount} opinions and ${result.postedCount} posted replies.`,
    };
  } catch (error) {
    console.error("Brain rebuild failed", error);
    return {
      status: "error",
      message:
        error instanceof OpenAI.APIError && error.status === 429
          ? "The AI service is busy or out of credits. Try again shortly."
          : "Rebuild failed. Try again in a moment.",
    };
  }
}
