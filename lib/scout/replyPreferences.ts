// Reply preferences: what the user wants to reply to, and what not. Written
// by the user, stored apart from the Scout Brain, so a Brain rebuild never
// touches them. Different from lowConfidenceTopics, which means "the Brain
// isn't sure this interests you", not "I don't want this". Pure: no I/O.

export type ReplyPreferences = {
  /** e.g. "takes and predictions about AI coding" */
  want: string[];
  /** e.g. "newsletter tool promos", "follower milestones" */
  avoid: string[];
};

export const REPLY_PREFERENCE_LIMITS = { items: 10, chars: 120 };

export const EMPTY_REPLY_PREFERENCES: ReplyPreferences = { want: [], avoid: [] };

/** Trimmed, de-duplicated, within limits; blank lines dropped. */
export function normalizeReplyPreferences(input: Partial<ReplyPreferences> | null | undefined): ReplyPreferences {
  const clean = (items: string[] | undefined) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of items ?? []) {
      const item = raw.replace(/\s+/g, " ").trim().slice(0, REPLY_PREFERENCE_LIMITS.chars);
      const key = item.toLowerCase();
      if (!item || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= REPLY_PREFERENCE_LIMITS.items) break;
    }
    return result;
  };
  return { want: clean(input?.want), avoid: clean(input?.avoid) };
}

// Words that describe posts rather than their subject
const STOPWORDS = new Set(
  "a an the and or of to in on for with about at by from into over is are be it its this that these those my your our their i me we you they he she not no any all every everything anything something stuff things thing related posts post takes take tweets tweet content people news like just more most very really also how what why when who where".split(
    " ",
  ),
);

/** Subject words: lowercased, 2+ characters (keeps "ai", "ux"), simple plural folding. */
export function subjectWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word))
    .map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return new Set(words);
}

/** The first preference item sharing at least `minOverlap` subject words with the text. */
export function matchPreference(text: string, items: string[], minOverlap = 1): string | null {
  const words = subjectWords(text);
  for (const item of items) {
    const itemWords = [...subjectWords(item)];
    const needed = Math.min(minOverlap, itemWords.length);
    if (needed > 0 && itemWords.filter((word) => words.has(word)).length >= needed) return item;
  }
  return null;
}

// Broad words that swallow whole fields: avoiding "tech" also avoids AI,
// software and SaaS. Kept small and explicit on purpose.
const BROAD_TERMS: Record<string, string[]> = {
  tech: ["ai", "software", "saas", "coding", "code", "programming", "developer", "dev", "app", "startup", "product", "design", "llm", "agent", "model", "tool"],
  technology: ["ai", "software", "saas", "coding", "programming", "developer", "app", "startup", "product", "llm"],
  software: ["saas", "app", "coding", "code", "developer", "programming", "product"],
  business: ["startup", "saas", "marketing", "sale", "growth", "founder", "pricing"],
  startup: ["founder", "saas", "product", "fundraising", "growth"],
  marketing: ["growth", "audience", "content", "brand"],
};
const SWEEPING = /\b(everything|anything|all|any)\b/i;

export type PreferenceConflict = {
  /** The avoid entry, as the user wrote it */
  avoid: string;
  /** "avoidTopics" (onboarding) or "replyPreferences.avoid" */
  source: "avoidTopics" | "replyPreferences.avoid";
  /** Positive items it would also exclude */
  conflictsWith: string[];
  reason: "same_words" | "too_broad";
};

/**
 * Avoid entries that also cover something the user wants: the same subject
 * words, or a broad term ("everything related to tech") that swallows a
 * positive topic (AI, Software…). Shown in Settings; nothing is changed.
 */
export function detectPreferenceConflicts({
  positive,
  avoidTopics,
  preferences,
}: {
  /** Brain topics and expertise, plus replyPreferences.want */
  positive: string[];
  /** Onboarding "topics to avoid", free text */
  avoidTopics: string | null;
  preferences: ReplyPreferences;
}): PreferenceConflict[] {
  const entries: { avoid: string; source: PreferenceConflict["source"] }[] = [
    ...(avoidTopics ?? "")
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((avoid) => ({ avoid, source: "avoidTopics" as const })),
    ...preferences.avoid.map((avoid) => ({ avoid, source: "replyPreferences.avoid" as const })),
  ];
  const conflicts: PreferenceConflict[] = [];
  for (const { avoid, source } of entries) {
    const avoidWords = subjectWords(avoid);
    const broad = [...avoidWords].flatMap((word) => BROAD_TERMS[word] ?? []);
    const same: string[] = [];
    const swallowed: string[] = [];
    for (const item of positive) {
      const words = subjectWords(item);
      // Same subject: one side's words all appear in the other ("SaaS news"
      // vs "SaaS"). One shared generic word ("tools") is not a conflict.
      const within = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((word) => b.has(word));
      if (within(avoidWords, words) || within(words, avoidWords)) same.push(item);
      else if (broad.some((word) => words.has(word))) swallowed.push(item);
    }
    if (same.length) conflicts.push({ avoid, source, conflictsWith: same, reason: "same_words" });
    else if (swallowed.length && (SWEEPING.test(avoid) || avoidWords.size <= 2)) {
      conflicts.push({ avoid, source, conflictsWith: swallowed, reason: "too_broad" });
    }
  }
  return conflicts;
}

/** Score nudge from preferences; the offline evaluation tunes the sizes. */
export type PreferenceNudge = {
  wantPoints: number;
  avoidPoints: number;
  /** Subject words a post must share with a preference item */
  minOverlap: number;
  /** A wanted post the model scored but didn't mark shouldEngage may surface */
  wantOverridesEngage: boolean;
};

export function applyPreferenceNudge(
  candidate: { text: string; score: number; shouldEngage: boolean },
  preferences: ReplyPreferences,
  nudge: PreferenceNudge,
  threshold: number,
): { score: number; surfaced: boolean; want: string | null; avoid: string | null } {
  const want = matchPreference(candidate.text, preferences.want, nudge.minOverlap);
  const avoid = matchPreference(candidate.text, preferences.avoid, nudge.minOverlap);
  const score = Math.max(0, Math.min(100, candidate.score + (want ? nudge.wantPoints : 0) - (avoid ? nudge.avoidPoints : 0)));
  const engage = candidate.shouldEngage || Boolean(want && !avoid && nudge.wantOverridesEngage);
  return { score, surfaced: engage && score >= threshold, want, avoid };
}
