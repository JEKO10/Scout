import "server-only";

import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";

import db from "@/db";
import {
  opportunitiesTable,
  type Opportunity,
  postsTable,
  repliesTable,
  scoutRunsTable,
  socialAccountsTable,
  watchlistAccountsTable,
} from "@/db/schema";

/**
 * Everything that belongs to one Scout profile and is needed by the workspace.
 * Keeping the ownership filter here prevents UI code from ever querying data
 * for an arbitrary authenticated user.
 */
export async function getWorkspaceData(profileId: string) {
  const [socialAccounts, posts, watchlist, scoutRuns, opportunities, replies] =
    await Promise.all([
      db
        .select()
        .from(socialAccountsTable)
        .where(eq(socialAccountsTable.profileId, profileId))
        .orderBy(desc(socialAccountsTable.createdAt)),
      db
        .select({ post: postsTable, account: socialAccountsTable })
        .from(postsTable)
        .innerJoin(
          socialAccountsTable,
          eq(postsTable.socialAccountId, socialAccountsTable.id),
        )
        .where(eq(socialAccountsTable.profileId, profileId))
        .orderBy(desc(postsTable.publishedAt)),
      db
        .select()
        .from(watchlistAccountsTable)
        .where(eq(watchlistAccountsTable.profileId, profileId))
        .orderBy(desc(watchlistAccountsTable.createdAt)),
      db
        .select()
        .from(scoutRunsTable)
        .where(eq(scoutRunsTable.profileId, profileId))
        .orderBy(desc(scoutRunsTable.createdAt)),
      db
        .select()
        .from(opportunitiesTable)
        .where(eq(opportunitiesTable.profileId, profileId))
        .orderBy(desc(opportunitiesTable.score), desc(opportunitiesTable.createdAt)),
      db
        .select({ reply: repliesTable, opportunity: opportunitiesTable })
        .from(repliesTable)
        .innerJoin(
          opportunitiesTable,
          eq(repliesTable.opportunityId, opportunitiesTable.id),
        )
        .where(eq(opportunitiesTable.profileId, profileId))
        .orderBy(desc(repliesTable.createdAt)),
    ]);

  return {
    socialAccounts,
    posts,
    watchlist,
    scoutRuns,
    opportunities,
    replies,
  };
}

export type WorkspaceData = Awaited<ReturnType<typeof getWorkspaceData>>;

export type NewOpportunity = Omit<
  typeof opportunitiesTable.$inferInsert,
  "id" | "scoutRunId" | "profileId" | "createdAt" | "updatedAt"
>;

/** UNIQUE(profileId, platform, platformPostId): a post surfaces once per user. */
export async function saveOpportunities(
  scoutRunId: string,
  profileId: string,
  opportunities: NewOpportunity[],
): Promise<number> {
  if (opportunities.length === 0) return 0;

  const inserted = await db
    .insert(opportunitiesTable)
    .values(opportunities.map((item) => ({ ...item, scoutRunId, profileId })))
    .onConflictDoNothing({
      target: [
        opportunitiesTable.profileId,
        opportunitiesTable.platform,
        opportunitiesTable.platformPostId,
      ],
    })
    .returning({ id: opportunitiesTable.id });
  return inserted.length;
}

export const OPPORTUNITY_FILTERS = ["all", "new", "saved", "high", "replied"] as const;
export type OpportunityFilter = (typeof OPPORTUNITY_FILTERS)[number];

/** Score a post needs for the "High" filter */
export const HIGH_SCORE = 80;

// "all" means everything still in play: new and saved, not dismissed or replied
function filterCondition(filter: OpportunityFilter) {
  const inPlay = inArray(opportunitiesTable.status, ["new", "saved"]);
  switch (filter) {
    case "new":
      return eq(opportunitiesTable.status, "new");
    case "saved":
      return eq(opportunitiesTable.status, "saved");
    case "replied":
      return eq(opportunitiesTable.status, "replied");
    case "high":
      return and(inPlay, gte(opportunitiesTable.score, HIGH_SCORE));
    case "all":
      return inPlay;
  }
}

/** The feed: best first, then newest. */
export async function getOpportunities(
  profileId: string,
  filter: OpportunityFilter,
): Promise<Opportunity[]> {
  return db
    .select()
    .from(opportunitiesTable)
    .where(and(eq(opportunitiesTable.profileId, profileId), filterCondition(filter)))
    .orderBy(desc(opportunitiesTable.score), desc(opportunitiesTable.postedAt));
}

export async function countOpportunitiesByFilter(
  profileId: string,
): Promise<Record<OpportunityFilter, number>> {
  const inPlay = sql`${opportunitiesTable.status} in ('new', 'saved')`;
  const [row] = await db
    .select({
      all: count(sql`case when ${inPlay} then 1 end`),
      new: count(sql`case when ${opportunitiesTable.status} = 'new' then 1 end`),
      saved: count(sql`case when ${opportunitiesTable.status} = 'saved' then 1 end`),
      high: count(
        sql`case when ${inPlay} and ${opportunitiesTable.score} >= ${HIGH_SCORE} then 1 end`,
      ),
      replied: count(sql`case when ${opportunitiesTable.status} = 'replied' then 1 end`),
    })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.profileId, profileId));
  return row;
}

/** Returns false when the opportunity doesn't belong to this profile. */
export async function setOpportunityStatus(
  profileId: string,
  opportunityId: string,
  status: Opportunity["status"],
): Promise<boolean> {
  const updated = await db
    .update(opportunitiesTable)
    .set({ status })
    .where(
      and(
        eq(opportunitiesTable.id, opportunityId),
        eq(opportunitiesTable.profileId, profileId),
      ),
    )
    .returning({ id: opportunitiesTable.id });
  return updated.length > 0;
}

export async function getOpportunityForProfile(
  profileId: string,
  opportunityId: string,
): Promise<Opportunity | undefined> {
  const [opportunity] = await db
    .select()
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.id, opportunityId),
        eq(opportunitiesTable.profileId, profileId),
      ),
    )
    .limit(1);
  return opportunity;
}
