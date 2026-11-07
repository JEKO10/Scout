import { pickRelated } from "@/services/scout-brain/retrieval";

import type { UserMemory } from "./buildUserMemory";

/** Already-used arguments sent per reply: only those on the same subject */
const RELATED_ARGUMENTS = 3;

/**
 * The small, relevant slice of memory for one reply: a few real edits,
 * arguments already used on this subject, and history with this author.
 * Learned preferences come from the Learning Profile, not from here.
 * Null when there is nothing worth sending yet.
 */
export function formatMemoryForReply(
  memory: UserMemory,
  opportunity: { authorHandle: string | null; content: string; suggestedAngle: string | null },
): string | null {
  const subject = `${opportunity.content} ${opportunity.suggestedAngle ?? ""}`;
  const usedArguments = pickRelated(memory.arguments, (argument) => argument.text, subject, {
    count: RELATED_ARGUMENTS,
  });
  const person = memory.people.find(
    (entry) => entry.handle.toLowerCase() === opportunity.authorHandle?.toLowerCase(),
  );

  const block = {
    recentEdits: memory.editExamples,
    alreadyUsedArguments: usedArguments.map((argument) => argument.text),
    thisPerson: person && {
      handle: person.handle,
      repliesSoFar: person.interactions,
      repliesToday: person.today,
      lastReply: person.lastReply,
    },
  };

  const empty =
    block.recentEdits.length === 0 &&
    block.alreadyUsedArguments.length === 0 &&
    !block.thisPerson;
  return empty ? null : JSON.stringify(block, null, 2);
}
