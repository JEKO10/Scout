"use server";

import { redirect } from "next/navigation";

import { updateProfileByUserId } from "@/db/queries/profiles";
import { requireUser } from "@/lib/auth/session";
import { onboardingFieldNames, onboardingSchema } from "@/schemas/onboarding";

export type ProfileFormState = {
  status: "idle" | "success" | "error";
  message?: string;
};

function readFields(formData: FormData) {
  return onboardingSchema.safeParse(
    Object.fromEntries(
      onboardingFieldNames.map((field) => [
        field,
        String(formData.get(field) ?? ""),
      ]),
    ),
  );
}

export async function updateProfile(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const user = await requireUser();
  const result = readFields(formData);
  if (!result.success) {
    return {
      status: "error",
      message: result.error.issues[0]?.message ?? "Check your answers.",
    };
  }

  await updateProfileByUserId(user.id, result.data);
  return { status: "success", message: "Profile saved." };
}

export async function completeOnboarding(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const user = await requireUser();
  const result = readFields(formData);
  if (!result.success) {
    return {
      status: "error",
      message: result.error.issues[0]?.message ?? "Check your answers.",
    };
  }

  await updateProfileByUserId(user.id, {
    ...result.data,
    onboardingCompleted: true,
  });
  redirect("/dashboard");
}
