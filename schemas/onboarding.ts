import { z } from "zod";

export const onboardingFieldNames = [
  "displayName",
  "xHandle",
  "occupation",
  "bio",
  "targetAudience",
  "primaryGoal",
  "knownFor",
] as const;

export const xHandleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@+/, ""))
  .refine(
    (value) => /^[A-Za-z0-9_]{1,15}$/.test(value),
    "Enter a valid X handle.",
  );

const optionalText = (maxLength: number, label: string) =>
  z
    .string()
    .trim()
    .max(maxLength, `${label} must be ${maxLength} characters or fewer.`)
    .transform((value) => value || null);

const requiredText = (maxLength: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(maxLength, `${label} must be ${maxLength} characters or fewer.`);

export const onboardingSchema = z.object({
  displayName: requiredText(80, "Display name"),
  xHandle: xHandleSchema,
  occupation: requiredText(120, "Occupation"),
  bio: optionalText(500, "Bio"),
  targetAudience: requiredText(300, "Target audience"),
  primaryGoal: requiredText(120, "Primary goal"),
  knownFor: optionalText(300, "Known for"),
});

export type OnboardingValues = z.output<typeof onboardingSchema>;
