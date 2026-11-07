// What a user changed between Scout's draft and their final reply, detected in
// code: cheap, deterministic and inspectable. Pure functions, no I/O.

export type EditPattern =
  | "removed_agreement_opener"
  | "removed_hedging"
  | "removed_intensifiers"
  | "removed_question"
  | "shortened"
  | "lengthened"
  | "removed_emoji"
  | "removed_hashtags"
  | "removed_exclamation"
  | "lowercased";

/** Generic agreement openings like "Great point." or "100%," */
export const AGREEMENT_OPENER =
  /^\s*(great point|good point|i completely agree|i agree|couldn'?t agree more|this is so true|so true|absolutely|exactly|100\s?%|totally|agreed|love this|well said|this[.!]|yes[,.!]|true[,.!])/i;

const HEDGING = /\b(i think|i believe|i feel like|in my opinion|imo|probably|maybe|perhaps|kind of|sort of|arguably|it seems)\b/i;
const INTENSIFIERS = /\b(dramatically|incredibly|extremely|really|very|truly|completely|absolutely|massively|hugely|increasingly)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const HASHTAG = /(^|\s)#\w+/;
/** Length change that counts as a real rewrite, not a typo fix */
const LENGTH_CHANGE = 0.15;

export function detectEditPatterns(original: string, final: string): EditPattern[] {
  if (original.trim() === final.trim()) return [];
  const patterns: EditPattern[] = [];
  const removed = (pattern: RegExp) => pattern.test(original) && !pattern.test(final);

  if (removed(AGREEMENT_OPENER)) patterns.push("removed_agreement_opener");
  if (removed(HEDGING)) patterns.push("removed_hedging");
  if (removed(INTENSIFIERS)) patterns.push("removed_intensifiers");
  if (original.includes("?") && !final.includes("?")) patterns.push("removed_question");
  if (final.length < original.length * (1 - LENGTH_CHANGE)) patterns.push("shortened");
  if (final.length > original.length * (1 + LENGTH_CHANGE)) patterns.push("lengthened");
  if (removed(EMOJI)) patterns.push("removed_emoji");
  if (removed(HASHTAG)) patterns.push("removed_hashtags");
  if (original.includes("!") && !final.includes("!")) patterns.push("removed_exclamation");
  if (/^[A-Z]/.test(original.trim()) && /^[a-z]/.test(final.trim())) {
    patterns.push("lowercased");
  }
  return patterns;
}

/** Phrased as instructions for the Reply Engine */
export const editPatternLabels: Record<EditPattern, string> = {
  removed_agreement_opener: "Removes generic agreement openings (\"Great point\", \"I agree\")",
  removed_hedging: "Removes hedging (\"I think\", \"probably\", \"maybe\")",
  removed_intensifiers: "Removes intensifiers (\"dramatically\", \"really\", \"very\")",
  removed_question: "Prefers direct statements over questions",
  shortened: "Shortens replies",
  lengthened: "Expands replies with more detail",
  removed_emoji: "Removes emoji",
  removed_hashtags: "Removes hashtags",
  removed_exclamation: "Removes exclamation marks",
  lowercased: "Starts replies lowercase",
};
