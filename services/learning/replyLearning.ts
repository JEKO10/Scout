import type { LearningProfile } from "@/lib/scout/learning";

/**
 * Learned writing preferences for the Reply Engine, each with its evidence.
 * Concrete rules ("under 90 characters") instead of "write in their style".
 * Null until something has been learned.
 */
export function formatLearningForReply(learning: LearningProfile | null): string | null {
  if (!learning) return null;

  const block = {
    replyLength: learning.preferredReplyLength && {
      rule: `Keep each draft at or under ${learning.preferredReplyLength.targetChars} characters.`,
      evidence: learning.preferredReplyLength.evidence,
    },
    preferredVariant: learning.variantPreference && {
      rule: `They usually pick: ${learning.variantPreference.label}. Make that draft especially strong.`,
      evidence: learning.variantPreference.evidence,
    },
    do: learning.stylePreferences.map((item) => `${item.label} (${item.evidence})`),
    avoid: learning.styleAvoidances.map((item) => `${item.label} (${item.evidence})`),
    overusedArguments: learning.overusedAngles.map((item) => item.label),
  };

  const empty =
    !block.replyLength &&
    !block.preferredVariant &&
    block.do.length === 0 &&
    block.avoid.length === 0 &&
    block.overusedArguments.length === 0;
  return empty ? null : JSON.stringify(block, null, 2);
}
