"use server";

import { redirect } from "next/navigation";
import OpenAI from "openai";
import { z } from "zod";

import { updateProfileByUserId } from "@/db/queries/profiles";
import { replaceOnboardingSamples } from "@/db/queries/voiceSamples";
import { requireProfile } from "@/lib/auth/session";
import { onboardingFieldNames, onboardingSchema } from "@/schemas/onboarding";
import { analyzeUser } from "@/services/scout-brain/analyzeUser";
import { buildColdStartBrain } from "@/services/scout-brain/buildColdStartBrain";
import { addWatchlistAccount } from "@/services/watchlist/addAccount";

import type { ProfileFormState } from "./profile";

export type OnboardingMode = "posts" | "scratch";

const modeSchema = z.enum(["posts", "scratch"]);

/** Step 2: the guided questions. Both modes answer them (goals come from here). */
export async function saveOnboardingAnswersAction(
  mode: OnboardingMode,
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const { user } = await requireProfile();
  const result = onboardingSchema.safeParse(
    Object.fromEntries(
      onboardingFieldNames.map((field) => [field, String(formData.get(field) ?? "")]),
    ),
  );
  if (!result.success) {
    return {
      status: "error",
      message: result.error.issues[0]?.message ?? "Check your answers.",
    };
  }

  // Answers only; onboardingCompleted is set at the very end
  await updateProfileByUserId(user.id, result.data);
  const next = modeSchema.parse(mode) === "posts" ? "brain" : "voice";
  redirect(`/onboarding?step=${next}&mode=${mode}`);
}

const samplesSchema = z
  .array(
    z.object({
      promptPost: z.string().trim().min(1).max(1000),
      userReply: z.string().trim().min(1, "Write a reply or skip this step.").max(500),
    }),
  )
  .max(5);

/** Step 3: voice calibration replies. Re-calibrating replaces the old ones. */
export async function saveVoiceSamplesAction(
  samples: { promptPost: string; userReply: string }[],
): Promise<{ ok: boolean; message?: string }> {
  const { profile } = await requireProfile();
  const parsed = samplesSchema.safeParse(samples);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check your replies." };
  }
  await replaceOnboardingSamples(profile.id, parsed.data);
  return { ok: true };
}

/** Step 4: the Scout Brain, from X history or from onboarding. Same schema either way. */
export async function buildOnboardingBrainAction(
  mode: OnboardingMode,
): Promise<{ ok: boolean; message?: string }> {
  const { profile } = await requireProfile();

  try {
    if (modeSchema.parse(mode) === "posts") {
      const result = await analyzeUser(profile.id);
      if (result.status === "not_enough_posts") {
        return {
          ok: false,
          message: `Only ${result.postCount} usable posts. Go back and start from scratch instead.`,
        };
      }
    } else {
      await buildColdStartBrain(profile.id);
    }
    return { ok: true };
  } catch (error) {
    console.error("Onboarding brain failed", error);
    return {
      ok: false,
      message:
        error instanceof OpenAI.APIError && error.status === 429
          ? "The AI service is busy or out of credits. Try again shortly."
          : "Couldn't build your Scout Brain. Try again.",
    };
  }
}

const handlesSchema = z
  .array(z.string().trim().regex(/^[A-Za-z0-9_]{1,15}$/))
  .max(20);

/** Step 5: add the chosen suggestions to the watchlist and finish onboarding. */
export async function finishOnboardingAction(handles: string[]): Promise<void> {
  const { user, profile } = await requireProfile();

  for (const handle of handlesSchema.parse(handles)) {
    // Duplicates and a full watchlist are skipped, not fatal
    await addWatchlistAccount(profile.id, handle);
  }
  await updateProfileByUserId(user.id, { onboardingCompleted: true });
  redirect("/dashboard");
}
