import { z } from "zod";

export const onboardingFieldNames = [
  "displayName",
  "xHandle",
  "occupation",
  "bio",
  "targetAudience",
  "primaryGoal",
  "knownFor",
  "topics",
  "avoidTopics",
  "voiceDescription",
] as const;

export const xHandleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@+/, ""))
  .refine(
    (value) => /^[A-Za-z0-9_]{1,15}$/.test(value),
    "Enter a valid X handle.",
  );

/** No X account is fine (Day 14 cold start): empty means none */
const optionalXHandle = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@+/, ""))
  .refine(
    (value) => value === "" || /^[A-Za-z0-9_]{1,15}$/.test(value),
    "Enter a valid X handle, or leave it empty.",
  )
  .transform((value) => value || null);

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
  xHandle: optionalXHandle,
  occupation: requiredText(120, "Occupation"),
  bio: optionalText(500, "Bio"),
  targetAudience: requiredText(300, "Target audience"),
  // Day 22: goals can be several choices, stored comma-separated
  primaryGoal: requiredText(300, "Primary goal"),
  knownFor: optionalText(300, "Known for"),
  topics: requiredText(300, "Topics you know"),
  avoidTopics: optionalText(300, "Topics to avoid"),
  voiceDescription: requiredText(300, "How you want to sound"),
});

export type OnboardingValues = z.output<typeof onboardingSchema>;
