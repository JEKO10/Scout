import type { ReplyPair } from "@/db/queries/replies";

import type { DraftPair, DraftReply } from "./ReplyDrafts";

const toDraft = (reply: ReplyPair["natural"] | undefined): DraftReply | undefined =>
  reply && {
    id: reply.id,
    variant: reply.variant,
    content: reply.content,
    originalContent: reply.originalContent,
    status: reply.status,
  };

/** Only the fields the client needs from a server-side reply pair. */
export function toDraftPair(pair: Partial<ReplyPair> | undefined): DraftPair {
  return { natural: toDraft(pair?.natural), strongerTake: toDraft(pair?.strongerTake) };
}
