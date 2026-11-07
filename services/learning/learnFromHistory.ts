import type {
  LearnedAccount,
  LearnedItem,
  LearnedTopic,
  LearningProfile,
  Strength,
} from "@/lib/scout/learning";
import type { UserMemory } from "@/services/memory/buildUserMemory";
import type { EditPattern } from "@/services/memory/editPatterns";
import { keywords } from "@/services/scout-brain/retrieval";

// Patterns, not single events: every conclusion needs repeated evidence and
// carries that evidence with it. Pure: Memory + current profile → new profile.

/** New interactions that trigger a re-learn */
export const RELEARN_EVERY = 10;
/** Edits looked at for writing patterns: recent behavior counts most */
const RECENT_EDITS = 10;
const MIN_REPEATS = 3;
const STRONG_REPEATS = 5;
/** Final/original length at or below this counts as a real shortening */
const SHORTENED_RATIO = 0.8;
const LENGTHENED_RATIO = 1.2;
const DEFAULT_TARGET_CHARS = 140;

const strength = (count: number): Strength => (count >= STRONG_REPEATS ? "strong" : "mild");

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Writing patterns, phrased as what to do or avoid
const STYLE_RULES: Partial<
  Record<EditPattern, { kind: "prefer" | "avoid"; label: string }>
> = {
  removed_agreement_opener: { kind: "avoid", label: "Generic agreement openings (\"Great point\", \"I agree\")" },
  removed_hedging: { kind: "avoid", label: "Hedging (\"I think\", \"probably\", \"maybe\")" },
  removed_intensifiers: { kind: "avoid", label: "Intensifiers (\"dramatically\", \"really\", \"very\")" },
  removed_emoji: { kind: "avoid", label: "Emoji" },
  removed_hashtags: { kind: "avoid", label: "Hashtags" },
  removed_exclamation: { kind: "avoid", label: "Exclamation marks" },
  removed_question: { kind: "prefer", label: "Direct statements over questions" },
  lowercased: { kind: "prefer", label: "Starting replies lowercase" },
};

export function shouldRelearn(memory: UserMemory, current: LearningProfile | null): boolean {
  if (!current) return memory.interactionCount > 0;
  return memory.interactionCount - current.interactionsAtUpdate >= RELEARN_EVERY;
}

export function learnFromHistory(
  memory: UserMemory,
  current: LearningProfile | null,
  now: Date,
): LearningProfile {
  const rejectedKeys = current?.rejectedKeys ?? [];
  const allowed = <T extends LearnedItem>(item: T | null) =>
    item && !rejectedKeys.includes(item.key) ? item : null;
  const allowedList = <T extends LearnedItem>(items: T[]) =>
    items.filter((item) => !rejectedKeys.includes(item.key));

  const recentEdits = memory.edits.slice(0, RECENT_EDITS);

  // ---- Reply length: edits weigh most; accepted lengths set the target ----
  const targetChars = median(memory.acceptedLengths.slice(0, RECENT_EDITS)) ?? DEFAULT_TARGET_CHARS;
  const shortened = recentEdits.filter((edit) => edit.lengthRatio <= SHORTENED_RATIO);
  const lengthened = recentEdits.filter((edit) => edit.lengthRatio >= LENGTHENED_RATIO);
  const cutRange = (edits: typeof recentEdits) => {
    const cuts = edits.map((edit) => Math.round((1 - edit.lengthRatio) * 100));
    return `${Math.min(...cuts)}–${Math.max(...cuts)}%`;
  };

  let preferredReplyLength: LearningProfile["preferredReplyLength"] = null;
  if (shortened.length >= MIN_REPEATS && shortened.length >= recentEdits.length * 0.6) {
    preferredReplyLength = {
      key: "length:short",
      label: `Short replies, around ${targetChars} characters`,
      evidence: `Shortened ${shortened.length} of the last ${recentEdits.length} edits by ${cutRange(shortened)}`,
      strength: strength(shortened.length),
      value: "short",
      targetChars,
    };
  } else if (lengthened.length >= MIN_REPEATS && lengthened.length >= recentEdits.length * 0.6) {
    preferredReplyLength = {
      key: "length:long",
      label: `Longer, more detailed replies, around ${targetChars} characters`,
      evidence: `Expanded ${lengthened.length} of the last ${recentEdits.length} edits`,
      strength: strength(lengthened.length),
      value: "long",
      targetChars,
    };
  }

  // ---- Writing style: patterns repeated across recent edits ----
  const stylePreferences: LearnedItem[] = [];
  const styleAvoidances: LearnedItem[] = [];
  for (const [pattern, rule] of Object.entries(STYLE_RULES) as [EditPattern, NonNullable<(typeof STYLE_RULES)[EditPattern]>][]) {
    const count = recentEdits.filter((edit) => edit.patterns.includes(pattern)).length;
    if (count < MIN_REPEATS || count < recentEdits.length * 0.5) continue;
    const item = {
      key: `style:${pattern}`,
      label: rule.label,
      evidence: `In ${count} of the last ${recentEdits.length} edits`,
      strength: strength(count),
    };
    (rule.kind === "prefer" ? stylePreferences : styleAvoidances).push(item);
  }

  // ---- Natural vs stronger take ----
  const picked = memory.variants.natural + memory.variants.strongerTake;
  let variantPreference: LearningProfile["variantPreference"] = null;
  for (const [value, count, label] of [
    ["natural", memory.variants.natural, "Natural, first-instinct replies"],
    ["stronger_take", memory.variants.strongerTake, "Stronger takes"],
  ] as const) {
    if (count >= MIN_REPEATS + 1 && count >= picked * 0.7) {
      variantPreference = {
        key: `variant:${value}`,
        label,
        evidence: `Picked ${count} of ${picked} times`,
        strength: strength(count),
        value,
      };
    }
  }

  // ---- Topics: engagement vs skips, one direction clearly dominating ----
  const preferredTopics: LearnedTopic[] = [];
  const avoidedTopics: LearnedTopic[] = [];
  for (const signal of memory.topicSignals) {
    const base = { topic: signal.topic, engaged: signal.engaged, dismissed: signal.dismissed };
    if (signal.engaged >= MIN_REPEATS && signal.engaged >= signal.dismissed * 2) {
      preferredTopics.push({
        ...base,
        key: `topic+:${signal.topic.toLowerCase()}`,
        label: signal.topic,
        evidence: `Engaged ${signal.engaged}×, skipped ${signal.dismissed}×`,
        strength: strength(signal.engaged),
      });
    } else if (signal.dismissed >= MIN_REPEATS && signal.dismissed >= signal.engaged * 2) {
      avoidedTopics.push({
        ...base,
        key: `topic-:${signal.topic.toLowerCase()}`,
        label: signal.topic,
        evidence: `Skipped ${signal.dismissed}×, engaged ${signal.engaged}×`,
        strength: strength(signal.dismissed),
      });
    }
  }

  // ---- Angles: what landed, and points already made more than once ----
  const recentArguments = memory.arguments.slice(0, 20).map((argument) => argument.text);
  const overusedAngles: LearnedItem[] = [];
  const counted = new Set<number>();
  recentArguments.forEach((text, i) => {
    if (counted.has(i)) return;
    const words = keywords(text);
    const similar = recentArguments
      .map((other, j) => ({ j, overlap: [...keywords(other)].filter((w) => words.has(w)).length }))
      .filter(({ j, overlap }) => j !== i && overlap >= 3);
    if (similar.length === 0) return;
    similar.forEach(({ j }) => counted.add(j));
    overusedAngles.push({
      key: `angle:${[...words].slice(0, 5).join("-")}`,
      label: text,
      evidence: `Made ${similar.length + 1} times recently`,
      strength: strength(similar.length + 1),
    });
  });

  // ---- Accounts the user keeps choosing to reply to ----
  const preferredAccounts: LearnedAccount[] = memory.people
    .filter((person) => person.interactions >= MIN_REPEATS)
    .map((person) => ({
      key: `account:${person.handle.toLowerCase()}`,
      label: `@${person.handle}`,
      evidence: `${person.interactions} replies`,
      strength: strength(person.interactions),
      handle: person.handle,
      interactions: person.interactions,
    }));

  return {
    updatedAt: now.toISOString(),
    interactionsAtUpdate: memory.interactionCount,
    preferredReplyLength: allowed(preferredReplyLength),
    variantPreference: allowed(variantPreference),
    stylePreferences: allowedList(stylePreferences),
    styleAvoidances: allowedList(styleAvoidances),
    preferredTopics: allowedList(preferredTopics),
    avoidedTopics: allowedList(avoidedTopics),
    successfulAngles: recentArguments.slice(0, 10),
    overusedAngles: allowedList(overusedAngles),
    preferredAccounts: allowedList(preferredAccounts),
    rejectedKeys,
  };
}
