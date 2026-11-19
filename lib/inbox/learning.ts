// Day 38: what Scout learns from the Approval Inbox. Deterministic counting
// over the user's own decisions and edits: no AI call. One action never
// changes anything; a preference needs repeated, consistent signals.

import { type InboxPreferences, NO_PREFERENCES } from "./types";

export type InboxSignal =
  | { kind: "decision"; itemType: string; decision: string; reason: string | null; topic: string | null; goal: string | null; originalLength: number | null; finalLength: number | null }
  | { kind: "revision"; instruction: string | null; outcome: "accepted" | "rejected" | "pending" | null };

/** Thresholds: how many consistent signals a preference needs */
export const LEARNING = {
  shorter: 3,
  lessPromotional: 2,
  closerToVoice: 3,
  avoidTopic: 2,
  favoredGoal: 3,
  /** A manual edit that cut at least this share counts as "shortened" */
  shortenedRatio: 0.8,
} as const;

const GOAL_WORDS: Record<string, string> = {
  grow_audience: "audience-growth",
  build_authority: "expertise",
  generate_leads: "lead-focused",
  start_conversations: "conversation-starting",
  educate: "educational",
  promote_product: "promotional",
};

export function learnPreferences(signals: InboxSignal[]): InboxPreferences {
  if (signals.length === 0) return NO_PREFERENCES;
  const evidence: string[] = [];

  let shortened = 0;
  let lengthened = 0;
  let promoSignals = 0;
  let toneDeclines = 0;
  const declinedTopics = new Map<string, number>();
  const approvedTopics = new Set<string>();
  const approvedGoals = new Map<string, number>();
  let approvedPosts = 0;

  for (const signal of signals) {
    if (signal.kind === "revision") {
      if (signal.outcome !== "accepted") continue;
      if (signal.instruction === "shorter") shortened++;
      if (signal.instruction === "less_promo") promoSignals++;
      continue;
    }
    const topic = signal.topic?.trim().toLowerCase() || null;
    if (signal.decision === "approved" || signal.decision === "saved" || signal.decision === "accepted") {
      if (topic) approvedTopics.add(topic);
      if (signal.originalLength && signal.finalLength) {
        if (signal.finalLength <= signal.originalLength * LEARNING.shortenedRatio) shortened++;
        else if (signal.finalLength >= signal.originalLength * 1.2) lengthened++;
      }
      if (signal.itemType === "post") {
        approvedPosts++;
        if (signal.goal) approvedGoals.set(signal.goal, (approvedGoals.get(signal.goal) ?? 0) + 1);
      }
    }
    if (signal.decision === "declined" || signal.decision === "dismissed") {
      if (signal.reason === "too_promotional") promoSignals++;
      if (signal.reason === "wrong_tone") toneDeclines++;
      if (signal.reason === "not_relevant" && topic) declinedTopics.set(topic, (declinedTopics.get(topic) ?? 0) + 1);
    }
  }

  const shorter = shortened >= LEARNING.shorter && shortened > lengthened * 2;
  if (shorter) evidence.push(`You shortened ${shortened} drafts, so Scout writes shorter ones.`);
  const lessPromotional = promoSignals >= LEARNING.lessPromotional;
  if (lessPromotional) evidence.push(`${promoSignals} times you asked for less promotion, so drafts stay non-promotional.`);
  const closerToVoice = toneDeclines >= LEARNING.closerToVoice;
  if (closerToVoice) evidence.push(`You declined ${toneDeclines} drafts for their tone, so Scout stays closer to how you write.`);

  const avoidTopics = [...declinedTopics.entries()]
    .filter(([topic, count]) => count >= LEARNING.avoidTopic && !approvedTopics.has(topic))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);
  for (const topic of avoidTopics) evidence.push(`You marked "${topic}" not relevant ${declinedTopics.get(topic)} times, so Scout shows less of it.`);

  const [goal, goalCount] = [...approvedGoals.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  // Promotion is never "learned" upward
  const favoredGoal = goal && goal !== "promote_product" && goalCount >= LEARNING.favoredGoal && goalCount / approvedPosts >= 0.6 ? goal : null;
  if (favoredGoal) evidence.push(`You approved ${goalCount} ${GOAL_WORDS[favoredGoal] ?? favoredGoal} posts, so Scout prepares more of them.`);

  return { shorter, lessPromotional, closerToVoice, avoidTopics, favoredGoal, evidence };
}

/** The learned preferences as prompt lines (empty when nothing is learned) */
export function preferenceGuidance(prefs: InboxPreferences): string[] {
  const lines: string[] = [];
  if (prefs.shorter) lines.push("The user usually shortens drafts: keep it short and tight.");
  if (prefs.lessPromotional) lines.push("The user dislikes promotional drafts: no pitching, no product mentions unless asked.");
  if (prefs.closerToVoice) lines.push("The user declined drafts for their tone: stay very close to their own voice and wording.");
  if (prefs.avoidTopics.length) lines.push(`The user found these topics not relevant: ${prefs.avoidTopics.join(", ")}. Avoid them.`);
  return lines;
}
