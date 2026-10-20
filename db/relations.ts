import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  profilesTable: {
    socialAccounts: r.many.socialAccountsTable(),
    watchlistAccounts: r.many.watchlistAccountsTable(),
    scoutRuns: r.many.scoutRunsTable(),
    opportunities: r.many.opportunitiesTable(),
  },
  socialAccountsTable: {
    profile: r.one.profilesTable({
      from: r.socialAccountsTable.profileId,
      to: r.profilesTable.id,
      optional: false,
    }),
    posts: r.many.postsTable(),
  },
  postsTable: {
    socialAccount: r.one.socialAccountsTable({
      from: r.postsTable.socialAccountId,
      to: r.socialAccountsTable.id,
      optional: false,
    }),
  },
  watchlistAccountsTable: {
    profile: r.one.profilesTable({
      from: r.watchlistAccountsTable.profileId,
      to: r.profilesTable.id,
      optional: false,
    }),
  },
  scoutRunsTable: {
    profile: r.one.profilesTable({
      from: r.scoutRunsTable.profileId,
      to: r.profilesTable.id,
      optional: false,
    }),
    opportunities: r.many.opportunitiesTable(),
  },
  opportunitiesTable: {
    scoutRun: r.one.scoutRunsTable({
      from: r.opportunitiesTable.scoutRunId,
      to: r.scoutRunsTable.id,
      optional: false,
    }),
    profile: r.one.profilesTable({
      from: r.opportunitiesTable.profileId,
      to: r.profilesTable.id,
      optional: false,
    }),
    replies: r.many.repliesTable(),
  },
  repliesTable: {
    opportunity: r.one.opportunitiesTable({
      from: r.repliesTable.opportunityId,
      to: r.opportunitiesTable.id,
      optional: false,
    }),
  },
}));
