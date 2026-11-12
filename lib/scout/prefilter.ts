// Day 20: a deterministic pre-filter in front of AI scoring. Conservative by
// design: it drops only posts no Scout Brain could make worth a reply.
// Engagement, account size, length of a question and topic keywords are
// never reasons (a small account's short question can be the best reply
// opportunity of the day). Pure: no I/O.

export type PrefilterReason =
  "low_information" | "language_mismatch" | "duplicate_content";

export type PrefilterInput = {
  candidateId: string;
  /** What the candidate's author wrote */
  content: string;
  /** Quotes: the quoted post, by another account */
  quotedPost?: string;
};

const URL = /https?:\/\/\S+/g;
const MENTION = /(^|\s)@\w+/g;
const WORD = /\p{L}[\p{L}\p{N}'’-]*/gu;

/** Chinese and Japanese are written without spaces between words */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/**
 * Words of real text: links, @mentions, emoji and punctuation removed. In
 * unspaced scripts every two characters count as a word.
 */
export function wordCount(text: string): number {
  const clean = text.replace(URL, " ").replace(MENTION, " ");
  const unspaced = clean.match(UNSPACED)?.length ?? 0;
  const spaced = clean.replace(UNSPACED, " ").match(WORD)?.length ?? 0;
  return spaced + Math.floor(unspaced / 2);
}

const SCRIPTS: [string, RegExp][] = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["arabic", /\p{Script=Arabic}/u],
  // Chinese and Japanese share Han characters: one group
  ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["thai", /\p{Script=Thai}/u],
  ["greek", /\p{Script=Greek}/u],
];

/** Letters per writing system, links and mentions excluded. */
export function scriptCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of text.replace(URL, " ").replace(MENTION, " ")) {
    if (!/\p{L}/u.test(char)) continue;
    const script =
      SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0] ?? "other";
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return counts;
}

/** Thresholds, named so the evaluation can report exactly what was applied. */
export const PREFILTER_RULES = {
  /** Fewer real words than this, no question and no substantial quote */
  minWords: 3,
  /** A quoted post this long carries the conversation, whatever the quote says */
  substantialQuoteWords: 8,
  /** Language: a post this dominated by one writing system… */
  dominantScriptShare: 0.8,
  minLettersForLanguage: 20,
  /** …that the user's own writing (at least this much of it) almost never uses */
  minUserLetters: 200,
  maxUserScriptShare: 0.02,
  /** Exact duplicates only count from this length (short phrases repeat innocently) */
  minDuplicateChars: 40,
};

function dominantScript(text: string): string | null {
  const counts = scriptCounts(text);
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (total < PREFILTER_RULES.minLettersForLanguage) return null;
  for (const [script, value] of counts) {
    if (value / total >= PREFILTER_RULES.dominantScriptShare) return script;
  }
  return null;
}

const normalize = (text: string) =>
  text.replace(URL, " ").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Splits candidates into those worth AI scoring and those that are not.
 * `userWriting`: the user's own posts or onboarding replies; without enough
 * of it the language rule is off (no evidence what the user writes in).
 */
export function prefilterCandidates<T extends PrefilterInput>(
  candidates: T[],
  { userWriting }: { userWriting: string[] },
): { keep: T[]; rejected: { candidate: T; reason: PrefilterReason }[] } {
  const userScripts = scriptCounts(userWriting.join(" "));
  const userLetters = [...userScripts.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const seen = new Set<string>();
  const keep: T[] = [];
  const rejected: { candidate: T; reason: PrefilterReason }[] = [];

  for (const candidate of candidates) {
    const own = candidate.content;
    const quoteWords = candidate.quotedPost
      ? wordCount(candidate.quotedPost)
      : 0;

    // "gm", "🔥🔥🔥", "lol", a bare link: nothing to reply to. A question,
    // however short, or a substantial quoted post always goes to scoring.
    if (
      wordCount(own) < PREFILTER_RULES.minWords &&
      !/[?？]/.test(own) &&
      quoteWords < PREFILTER_RULES.substantialQuoteWords
    ) {
      rejected.push({ candidate, reason: "low_information" });
      continue;
    }

    const script = dominantScript(`${own} ${candidate.quotedPost ?? ""}`);
    if (
      script &&
      userLetters >= PREFILTER_RULES.minUserLetters &&
      (userScripts.get(script) ?? 0) / userLetters <
        PREFILTER_RULES.maxUserScriptShare
    ) {
      rejected.push({ candidate, reason: "language_mismatch" });
      continue;
    }

    const key = normalize(`${own} ${candidate.quotedPost ?? ""}`);
    if (key.length >= PREFILTER_RULES.minDuplicateChars) {
      if (seen.has(key)) {
        rejected.push({ candidate, reason: "duplicate_content" });
        continue;
      }
      seen.add(key);
    }
    keep.push(candidate);
  }
  return { keep, rejected };
}
