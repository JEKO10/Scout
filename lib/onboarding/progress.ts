// Day 22 onboarding: where a user is, derived from what they have actually
// saved (answers, Scout Brain, watchlist). Nothing to keep in sync, nothing in
// localStorage: refresh, another device or a week later all resume at the
// same step. Pure: no I/O.

export type OnboardingStep = "welcome" | "connect" | "answers" | "voice" | "brain" | "accounts" | "scan";
export type OnboardingMode = "posts" | "scratch";

export const ONBOARDING_STEPS: Record<OnboardingMode, OnboardingStep[]> = {
  posts: ["welcome", "connect", "answers", "brain", "accounts", "scan"],
  scratch: ["welcome", "connect", "answers", "voice", "brain", "accounts", "scan"],
};

/** The four stages the progress bar shows */
export const ONBOARDING_STAGES = ["About you", "Your Scout Brain", "Accounts to watch", "First opportunities"] as const;

export function stageOf(step: OnboardingStep): number | null {
  switch (step) {
    case "welcome":
      return null;
    case "connect":
    case "answers":
      return 0;
    case "voice":
    case "brain":
      return 1;
    case "accounts":
      return 2;
    case "scan":
      return 3;
  }
}

export type OnboardingFacts = {
  completed: boolean;
  /** Anything entered yet: a handle or an answer */
  started: boolean;
  /** The required answers are saved */
  answered: boolean;
  /** Enough of the user's own posts to learn from (then no voice step) */
  mode: OnboardingMode;
  voiceSamples: number;
  hasBrain: boolean;
  activeAccounts: number;
};

/** The step a user resumes at when they open /onboarding without one. */
export function resumeStep(facts: OnboardingFacts): OnboardingStep {
  if (facts.completed) return "scan";
  if (!facts.answered) return facts.started ? "connect" : "welcome";
  if (!facts.hasBrain) return facts.mode === "scratch" && facts.voiceSamples === 0 ? "voice" : "brain";
  return "accounts";
}

/** Setup is complete only with a Scout Brain and at least one active account to watch. */
export function canComplete(facts: Pick<OnboardingFacts, "hasBrain" | "activeAccounts">): boolean {
  return facts.hasBrain && facts.activeAccounts > 0;
}

/**
 * What /onboarding shows. Finished users go to the dashboard unless they open
 * a step on purpose (from Settings); unfinished users can't skip ahead of
 * what they've saved.
 */
export function onboardingEntry(
  facts: OnboardingFacts,
  requested: string | null,
): { redirect: "/dashboard" } | { step: OnboardingStep } {
  const steps = ONBOARDING_STEPS[facts.mode];
  const valid = requested && (steps as string[]).includes(requested) ? (requested as OnboardingStep) : null;
  if (facts.completed) return valid ? { step: valid } : { redirect: "/dashboard" };
  const resume = resumeStep(facts);
  if (!valid) return { step: resume };
  // Never ahead of the saved progress (e.g. accounts before a Brain exists)
  return steps.indexOf(valid) <= steps.indexOf(resume) ? { step: valid } : { step: resume };
}

/** The required answers that make the "About you" step complete. */
export function hasRequiredAnswers(profile: {
  occupation: string | null;
  topics: string | null;
  primaryGoal: string | null;
  targetAudience: string | null;
  voiceDescription: string | null;
}): boolean {
  return [profile.occupation, profile.topics, profile.primaryGoal, profile.targetAudience, profile.voiceDescription].every(
    (value) => Boolean(value?.trim()),
  );
}

/** Choices offered in the About you step; stored in the existing text fields. */
export const GOAL_OPTIONS = [
  "Grow my audience",
  "Build authority",
  "Find potential customers",
  "Network with interesting people",
  "Drive traffic to my product",
  "Build in public",
] as const;

export const TOPIC_SUGGESTIONS = [
  "AI",
  "SaaS",
  "Startups",
  "Marketing",
  "Software engineering",
  "Design",
  "Entrepreneurship",
  "Product",
  "Growth",
] as const;

export const AVOID_SUGGESTIONS = ["Crypto speculation", "Political arguments", "Engagement bait"] as const;

export const TONE_OPTIONS = [
  "Direct and practical",
  "Friendly and casual",
  "Thoughtful and nuanced",
  "Witty",
  "Data-driven",
] as const;

/** "a, b, c" ↔ ["a", "b", "c"], trimmed and de-duplicated (case-insensitive). */
export function splitList(value: string | null | undefined): string[] {
  const seen = new Set<string>();
  return (value ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item && !seen.has(item.toLowerCase()) && seen.add(item.toLowerCase()));
}

export function joinList(items: string[]): string {
  return splitList(items.join(",")).join(", ");
}

// ---------------------------------------------------------------------------
// First opportunity: the score in plain English
// ---------------------------------------------------------------------------

const FACTORS = [
  { key: "relevance", max: 25, label: "it's about topics you know" },
  { key: "goalAlignment", max: 20, label: "replying serves your goal" },
  { key: "expertiseFit", max: 20, label: "your expertise gives you standing" },
  { key: "freshness", max: 15, label: "the conversation is fresh" },
  { key: "audienceValue", max: 10, label: "your audience is in it" },
  { key: "novelty", max: 10, label: "there's room for your own take" },
] as const;

/** e.g. "82/100: mostly because it's about topics you know and the conversation is fresh." */
export function explainScore(
  score: number,
  breakdown: Partial<Record<(typeof FACTORS)[number]["key"], number>> | null,
): string {
  const rounded = Math.round(score);
  if (!breakdown) return `${rounded}/100.`;
  const strongest = FACTORS.map((factor) => ({ ...factor, share: (breakdown[factor.key] ?? 0) / factor.max }))
    .filter((factor) => factor.share >= 0.6)
    .sort((a, b) => b.share - a.share)
    .slice(0, 2);
  if (strongest.length === 0) return `${rounded}/100: a moderate match on several factors.`;
  return `${rounded}/100: mostly because ${strongest.map((factor) => factor.label).join(" and ")}.`;
}
