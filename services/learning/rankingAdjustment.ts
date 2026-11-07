import type { LearnedItem, LearningProfile } from "@/lib/scout/learning";
import { keywords } from "@/services/scout-brain/retrieval";

// Learning nudges the Opportunity Engine's base score; it never replaces it.
// Pure: no I/O.

const MAX_ADJUSTMENT = 10;
const POINTS = {
  preferredTopic: { mild: 2, strong: 4 },
  avoidedTopic: { mild: -3, strong: -6 },
  preferredAccount: 2,
  overEngagedAccount: -5,
  repeatedAngle: -6,
};
/** Shared keywords for an angle to count as "the same point" */
const SAME_ANGLE_OVERLAP = 3;

export type LearningAdjustment = { points: number; notes: string[] };

/** Topic labels come from the model, so match on shared words, not exact text */
function sameTopic(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const words = keywords(a);
  return [...keywords(b)].some((word) => words.has(word));
}

const signed = (points: number) => (points > 0 ? `+${points}` : String(points));

export function learningAdjustment(
  candidate: { topic: string | null; authorHandle: string; suggestedAngle: string | null },
  learning: LearningProfile | null,
  context: { overEngagedHandles: Set<string>; recentArguments: string[] },
): LearningAdjustment {
  const notes: string[] = [];
  let points = 0;
  const add = (value: number, note: string) => {
    points += value;
    notes.push(`${signed(value)} ${note}`);
  };

  if (learning && candidate.topic) {
    const topic = candidate.topic;
    const liked = learning.preferredTopics.find((item) => sameTopic(item.topic, topic));
    const disliked = learning.avoidedTopics.find((item) => sameTopic(item.topic, topic));
    if (liked) add(POINTS.preferredTopic[liked.strength], `you often engage with ${liked.topic}`);
    if (disliked) add(POINTS.avoidedTopic[disliked.strength], `you usually skip ${disliked.topic}`);
  }

  const handle = candidate.authorHandle.toLowerCase();
  if (context.overEngagedHandles.has(handle)) {
    add(POINTS.overEngagedAccount, `you've already replied to @${candidate.authorHandle} a lot today`);
  } else if (
    learning?.preferredAccounts.some((item: LearnedItem & { handle: string }) => item.handle.toLowerCase() === handle)
  ) {
    add(POINTS.preferredAccount, `you often reply to @${candidate.authorHandle}`);
  }

  if (candidate.suggestedAngle) {
    const angle = keywords(candidate.suggestedAngle);
    const repeated = context.recentArguments.some(
      (argument) => [...keywords(argument)].filter((word) => angle.has(word)).length >= SAME_ANGLE_OVERLAP,
    );
    if (repeated) add(POINTS.repeatedAngle, "you recently made a very similar point");
  }

  const clamped = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, points));
  return { points: clamped, notes };
}
