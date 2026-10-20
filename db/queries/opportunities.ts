import "server-only";

import { desc, eq } from "drizzle-orm";

import db from "@/db";
import {
  opportunitiesTable,
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
