import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import db from "@/db";
import {
  opportunitiesTable,
  type Opportunity,
  repliesTable,
  type ReplyIntent,
  replyIntentsTable,
} from "@/db/schema";

const t = replyIntentsTable;

export type RecordIntentResult =
  | { ok: true; intent: ReplyIntent }
  | { ok: false; reason: "not_found" | "not_an_x_post" };

/**
 * The user opened X's reply composer (or copied the reply) for one of their
 * opportunities. Idempotent: a repeated click updates the same history row
 * (text, time, count) instead of adding one. The opportunity leaves the feed
 * as "reply_opened"; a confirmed reply ("replied") is never downgraded.
 */
export async function recordReplyIntent(
  profileId: string,
  input: {
    opportunityId: string;
    replyId: string | null;
    text: string;
    source: ReplyIntent["source"];
    isValidPostId: (id: string) => boolean;
  },
): Promise<RecordIntentResult> {
  const [opportunity] = await db
    .select()
    .from(opportunitiesTable)
    .where(and(eq(opportunitiesTable.id, input.opportunityId), eq(opportunitiesTable.profileId, profileId)));
  if (!opportunity) return { ok: false, reason: "not_found" };
  if (opportunity.platform !== "x" || !input.isValidPostId(opportunity.platformPostId)) {
    return { ok: false, reason: "not_an_x_post" };
  }

  // The draft must belong to this opportunity, or it is ignored
  const [reply] = input.replyId
    ? await db
        .select()
        .from(repliesTable)
        .where(and(eq(repliesTable.id, input.replyId), eq(repliesTable.opportunityId, opportunity.id)))
    : [];
  const edited = reply ? reply.originalContent.trim() !== input.text : true;
  const previousStatus: Opportunity["status"] =
    opportunity.status === "reply_opened" || opportunity.status === "replied" ? "new" : opportunity.status;

  const [intent] = await db
    .insert(t)
    .values({
      profileId,
      opportunityId: opportunity.id,
      replyId: reply?.id ?? null,
      platformPostId: opportunity.platformPostId,
      text: input.text,
      edited,
      source: input.source,
      previousStatus,
    })
    .onConflictDoUpdate({
      target: t.opportunityId,
      set: {
        replyId: reply?.id ?? null,
        text: input.text,
        edited,
        source: input.source,
        openCount: sql`${t.openCount} + 1`,
        openedAt: sql`now()`,
        // A confirmed reply stays confirmed; a returned one is open again
        status: sql`case when ${t.status} = 'confirmed' then 'confirmed' else 'opened' end::reply_intent_status`,
        returnedAt: null,
      },
      // Only ever the owner's row
      setWhere: eq(t.profileId, profileId),
    })
    .returning();
  if (!intent) return { ok: false, reason: "not_found" };

  // The final text is the user's: keep it on the draft (as Copy always did)
  if (reply) {
    await db.update(repliesTable).set({ content: input.text, status: "approved" }).where(eq(repliesTable.id, reply.id));
  }
  await db
    .update(opportunitiesTable)
    .set({ status: "reply_opened" })
    .where(
      and(
        eq(opportunitiesTable.id, opportunity.id),
        eq(opportunitiesTable.profileId, profileId),
        inArray(opportunitiesTable.status, ["new", "saved", "dismissed", "reply_opened"]),
      ),
    );
  return { ok: true, intent };
}

/** "Mark as posted": self-reported by the user, never verified. */
export async function confirmReplyPosted(profileId: string, opportunityId: string): Promise<boolean> {
  const rows = await db
    .update(t)
    .set({ status: "confirmed", confirmedAt: sql`coalesce(${t.confirmedAt}, now())` })
    .where(and(eq(t.opportunityId, opportunityId), eq(t.profileId, profileId), inArray(t.status, ["opened", "confirmed"])))
    .returning({ id: t.id });
  if (rows.length === 0) return false;
  await db
    .update(opportunitiesTable)
    .set({ status: "replied" })
    .where(and(eq(opportunitiesTable.id, opportunityId), eq(opportunitiesTable.profileId, profileId)));
  return true;
}

/** "Return to opportunities": back to the feed in the status it had before. */
export async function returnToFeed(profileId: string, opportunityId: string): Promise<boolean> {
  const rows = await db
    .update(t)
    .set({ status: "returned", returnedAt: sql`now()` })
    .where(and(eq(t.opportunityId, opportunityId), eq(t.profileId, profileId), eq(t.status, "opened")))
    .returning({ previousStatus: t.previousStatus });
  if (rows.length === 0) return false;
  await db
    .update(opportunitiesTable)
    .set({ status: rows[0].previousStatus })
    .where(
      and(
        eq(opportunitiesTable.id, opportunityId),
        eq(opportunitiesTable.profileId, profileId),
        eq(opportunitiesTable.status, "reply_opened"),
      ),
    );
  return true;
}

/** Activity: replies opened on X or confirmed, newest first. */
export async function getReplyActivity(profileId: string, limit = 50) {
  return db
    .select({
      intent: t,
      opportunity: {
        id: opportunitiesTable.id,
        authorHandle: opportunitiesTable.authorHandle,
        content: opportunitiesTable.content,
        postUrl: opportunitiesTable.postUrl,
        score: opportunitiesTable.score,
      },
    })
    .from(t)
    .innerJoin(opportunitiesTable, eq(opportunitiesTable.id, t.opportunityId))
    .where(and(eq(t.profileId, profileId), inArray(t.status, ["opened", "confirmed"])))
    .orderBy(desc(t.openedAt))
    .limit(limit);
}

/**
 * Reply funnel for analytics. "opened" is measured by Scout; "confirmed" is
 * the user's word; verified publication isn't available (no X API).
 */
export async function getReplyIntentStats(profileId: string) {
  const [row] = await db
    .select({
      opened: sql<number>`count(*)::int`,
      reopened: sql<number>`count(*) filter (where ${t.openCount} > 1)::int`,
      edited: sql<number>`count(*) filter (where ${t.edited})::int`,
      confirmed: sql<number>`count(*) filter (where ${t.status} = 'confirmed')::int`,
      returned: sql<number>`count(*) filter (where ${t.status} = 'returned')::int`,
      viaClipboard: sql<number>`count(*) filter (where ${t.source} = 'clipboard')::int`,
    })
    .from(t)
    .where(eq(t.profileId, profileId));
  return row;
}
