import type { ReplySet } from "@/db/queries/replies";

import type { DraftReply } from "./ReplyDrafts";

/** Only the fields the client needs from a server-side reply set. */
export function toDrafts(replies: ReplySet | undefined): DraftReply[] {
  return (replies ?? []).map((reply) => ({
    id: reply.id,
    variant: reply.variant,
    content: reply.content,
    originalContent: reply.originalContent,
    status: reply.status,
  }));
}
