import "server-only";

import { and, desc, eq, inArray, ne } from "drizzle-orm";

import db from "@/db";
import { opportunitiesTable, repliesTable,type Reply } from "@/db/schema";
import type { ReplyDrafts } from "@/lib/ai/schemas/reply";

// Replies have no profileId; ownership always goes through their opportunity.

const ownedOpportunityIds = (profileId: string) =>
  db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.profileId, profileId));

export type ReplyPair = { natural: Reply; strongerTake: Reply };

/**
 * Saves a fresh generation. Earlier drafts for the opportunity become
 * "discarded" (kept, not deleted: what the user regenerated away from is
 * signal for Day 12). Both statements run in one atomic batch.
 */
export async function saveReplyDrafts(
  opportunityId: string,
  drafts: ReplyDrafts,
): Promise<ReplyPair> {
  const [, inserted] = await db.batch([
    db
      .update(repliesTable)
      .set({ status: "discarded" })
      .where(
        and(
          eq(repliesTable.opportunityId, opportunityId),
          eq(repliesTable.status, "draft"),
        ),
      ),
    db
      .insert(repliesTable)
      .values([
        {
          opportunityId,
          variant: "natural",
          originalContent: drafts.natural,
          content: drafts.natural,
        },
        {
          opportunityId,
          variant: "stronger_take",
          originalContent: drafts.strongerTake,
          content: drafts.strongerTake,
        },
      ])
      .returning(),
  ]);

  return {
    natural: inserted.find((reply) => reply.variant === "natural")!,
    strongerTake: inserted.find((reply) => reply.variant === "stronger_take")!,
  };
}

/** The latest live (not discarded) pair per opportunity. */
export async function getCurrentReplies(
  profileId: string,
  opportunityIds: string[],
): Promise<Map<string, Partial<ReplyPair>>> {
  if (opportunityIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(repliesTable)
    .where(
      and(
        inArray(repliesTable.opportunityId, opportunityIds),
        inArray(repliesTable.opportunityId, ownedOpportunityIds(profileId)),
        ne(repliesTable.status, "discarded"),
      ),
    )
    .orderBy(desc(repliesTable.createdAt));

  const pairs = new Map<string, Partial<ReplyPair>>();
  for (const reply of rows) {
    const pair = pairs.get(reply.opportunityId) ?? {};
    const key = reply.variant === "natural" ? "natural" : "strongerTake";
    pair[key] ??= reply; // rows are newest first
    pairs.set(reply.opportunityId, pair);
  }
  return pairs;
}

/** Keeps originalContent as the AI wrote it; only content changes. */
export async function updateReplyContent(
  profileId: string,
  replyId: string,
  content: string,
): Promise<Reply | undefined> {
  const [reply] = await db
    .update(repliesTable)
    .set({ content })
    .where(
      and(
        eq(repliesTable.id, replyId),
        inArray(repliesTable.opportunityId, ownedOpportunityIds(profileId)),
      ),
    )
    .returning();
  return reply;
}

/**
 * Copying means the user picked this reply to post on X: the reply becomes
 * "approved" and its opportunity "replied". Returns false if not theirs.
 */
export async function markReplyCopied(
  profileId: string,
  replyId: string,
): Promise<boolean> {
  const [reply] = await db
    .update(repliesTable)
    .set({ status: "approved" })
    .where(
      and(
        eq(repliesTable.id, replyId),
        inArray(repliesTable.opportunityId, ownedOpportunityIds(profileId)),
      ),
    )
    .returning({ opportunityId: repliesTable.opportunityId });
  if (!reply) return false;

  await db
    .update(opportunitiesTable)
    .set({ status: "replied" })
    .where(
      and(
        eq(opportunitiesTable.id, reply.opportunityId),
        eq(opportunitiesTable.profileId, profileId),
      ),
    );
  return true;
}
