"use server";

import { redirect } from "next/navigation";

import { updateProfileByUserId } from "@/db/queries/profiles";
import { requireUser } from "@/lib/auth/session";

export type ProfileFormState = {
  status: "idle" | "success" | "error";
  message?: string;
};

const fields = [
  "displayName",
  "occupation",
  "bio",
  "targetAudience",
  "primaryGoal",
  "knownFor",
] as const;

function readFields(formData: FormData) {
  return Object.fromEntries(
    fields.map((field) => {
      const value = String(formData.get(field) ?? "").trim();
      return [field, value || null];
    }),
  ) as Record<(typeof fields)[number], string | null>;
}

export async function updateProfile(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const user = await requireUser();
  await updateProfileByUserId(user.id, readFields(formData));
  return { status: "success", message: "Profile saved." };
}

export async function completeOnboarding(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const user = await requireUser();
  await updateProfileByUserId(user.id, {
    ...readFields(formData),
    onboardingCompleted: true,
  });
  redirect("/dashboard");
}
