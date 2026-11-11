import "server-only";

import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

import db from "@/db";
import { opportunitiesTable, repliesTable,type Reply } from "@/db/schema";
import type { ReplyStyle } from "@/lib/replies/styles";

// Replies have no profileId; ownership always goes through their opportunity.

const ownedOpportunityIds = (profileId: string) =>
  db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.profileId, profileId));

/** One generation: the drafts in the styles the user picked, in that order. */
export type ReplySet = Reply[];

/**
 * Saves a fresh generation. Earlier drafts for the opportunity become
 * "discarded" (kept, not deleted: what the user regenerated away from is
 * signal for Day 12). Both statements run in one atomic batch.
 */
export async function saveReplyDrafts(
  opportunityId: string,
  drafts: { style: ReplyStyle; text: string }[],
  instruction: string | null = null,
): Promise<ReplySet> {
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
      .values(
        drafts.map((draft) => ({
          opportunityId,
          variant: draft.style,
          originalContent: draft.text,
          content: draft.text,
          instruction,
        })),
      )
      .returning(),
  ]);

  return drafts.map((draft) => inserted.find((reply) => reply.variant === draft.style)!);
}

/**
 * The latest live (not discarded) generation per opportunity: the newest
 * replies saved together. A copied reply from an earlier generation stays
 * live in the database but is no longer on screen.
 */
export async function getCurrentReplies(
  profileId: string,
  opportunityIds: string[],
): Promise<Map<string, ReplySet>> {
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
    .orderBy(desc(repliesTable.createdAt), asc(repliesTable.variant));

  const sets = new Map<string, ReplySet>();
  for (const reply of rows) {
    const set = sets.get(reply.opportunityId);
    // Rows are newest first; one generation shares its createdAt
    if (!set) sets.set(reply.opportunityId, [reply]);
    else if (set[0].createdAt.getTime() === reply.createdAt.getTime()) set.push(reply);
  }
  return sets;
}

/** The styles of the profile's latest generation, as the default next time. */
export async function getLastReplyStyles(profileId: string): Promise<ReplyStyle[] | null> {
  const rows = await db
    .select({ variant: repliesTable.variant, createdAt: repliesTable.createdAt })
    .from(repliesTable)
    .where(inArray(repliesTable.opportunityId, ownedOpportunityIds(profileId)))
    .orderBy(desc(repliesTable.createdAt))
    .limit(2);
  if (rows.length < 2 || rows[0].createdAt.getTime() !== rows[1].createdAt.getTime()) {
    return null;
  }
  return rows.map((row) => row.variant);
}

/**
 * Replies the user copied to post (their final text, after edits) with the
 * post they answered, newest first: real writing for the Scout Brain.
 */
export async function getPostedReplies(
  profileId: string,
  limit: number,
): Promise<{ post: string; reply: string; authorHandle: string | null }[]> {
  return db
    .select({
      post: opportunitiesTable.content,
      reply: repliesTable.content,
      authorHandle: opportunitiesTable.authorHandle,
    })
    .from(repliesTable)
    .innerJoin(opportunitiesTable, eq(repliesTable.opportunityId, opportunitiesTable.id))
    .where(
      and(
        eq(opportunitiesTable.profileId, profileId),
        inArray(repliesTable.status, ["approved", "posted"]),
      ),
    )
    .orderBy(desc(repliesTable.updatedAt))
    .limit(limit);
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
