// Temporary profiles in the real development database, deleted after each
// test file, plus a restore of the global X usage counter they touch.
import { randomUUID } from "node:crypto";

import { eq, inArray, isNotNull } from "drizzle-orm";

import db from "@/db";
import { getXUsageToday } from "@/db/queries/xApiUsage";
import * as s from "@/db/schema";
import type { UsageLimits } from "@/lib/billing/plans";

const created: string[] = [];
/** X user IDs the tests watched: their shared cache rows are deleted too */
const xUsers = new Set<string>();
let usageBefore: Awaited<ReturnType<typeof getXUsageToday>> | null | undefined;

export async function rememberXUsage() {
  await assertNoRealScheduledWork();
  usageBefore = (await getXUsageToday()) ?? null;
}

/**
 * Day 20: tests write to the database (profiles, runs, deliveries) and the
 * scheduler and delivery worker take work of any profile, so they only ever
 * run against an isolated database: TEST_DATABASE_URL (or DATABASE_TEST_URL),
 * a Neon test branch. Never the production database.
 */
async function assertNoRealScheduledWork() {
  if (process.env.SCOUT_TESTS_ISOLATED_DB === "true") return;
  throw new Error(
    "Refusing to run: tests need an isolated database. Set TEST_DATABASE_URL to a Neon test branch.",
  );
}

/** A profile with a Scout Brain, so scoring runs (against the mocked OpenAI). */
export async function newProfile(overrides: Partial<UsageLimits> = {}) {
  const brain = await sourceBrain();
  const [p] = await db
    .insert(s.profilesTable)
    .values({
      userId: `test-${randomUUID()}`,
      voiceBrain: brain.voice as s.Profile["voiceBrain"],
      interestBrain: brain.interests as s.Profile["interestBrain"],
      goalBrain: brain.goals as s.Profile["goalBrain"],
      usageLimitOverrides: overrides,
    })
    .returning();
  created.push(p.id);
  return p;
}

export async function getProfile(id: string) {
  const [p] = await db.select().from(s.profilesTable).where(eq(s.profilesTable.id, id));
  return p;
}

export function setOverrides(profileId: string, overrides: Partial<UsageLimits>) {
  return db
    .update(s.profilesTable)
    .set({ usageLimitOverrides: overrides })
    .where(eq(s.profilesTable.id, profileId));
}

/** An X account a test fetched without watching it; deleted at cleanup. */
export function trackXUser(id: string) {
  xUsers.add(id);
}

/** Watched with a cursor already set, so each scan reads at most a page of new posts. */
export async function watch(profileId: string, userIds: string[], { cursor = true } = {}) {
  for (const id of userIds) xUsers.add(id);
  return db
    .insert(s.watchlistAccountsTable)
    .values(
      userIds.map((id) => ({
        profileId,
        platform: "x" as const,
        platformUserId: id,
        handle: `h${id}`,
        ...(cursor && { xCursor: { sinceId: "1" } }),
      })),
    )
    .returning();
}

/** Moves runs out of the 24 h window so testing mode allows the next one. */
export async function ageRuns(profileId: string) {
  const old = new Date(Date.now() - 25 * 3600_000);
  await db
    .update(s.scoutRunsTable)
    .set({ createdAt: old, startedAt: old })
    .where(eq(s.scoutRunsTable.profileId, profileId));
}

export async function candidateIds(profileId: string) {
  const rows = await db
    .select()
    .from(s.scoutCandidatesTable)
    .where(eq(s.scoutCandidatesTable.profileId, profileId));
  return rows.map((row) => row.platformPostId);
}

/** The shared X cursor for an account; undefined before its first shared fetch. */
export async function sharedCursor(userId: string) {
  const [row] = await db
    .select()
    .from(s.xAccountsTable)
    .where(eq(s.xAccountsTable.platformUserId, userId));
  return row?.cursor;
}

export async function cachedPostIds(userId: string) {
  const rows = await db
    .select()
    .from(s.xPostsTable)
    .where(eq(s.xPostsTable.authorPlatformUserId, userId));
  return rows.map((row) => row.platformPostId);
}

export async function cleanup() {
  if (created.length) {
    await db.delete(s.profilesTable).where(inArray(s.profilesTable.id, created));
  }
  if (xUsers.size) {
    // Cascades to their cached posts
    await db.delete(s.xAccountsTable).where(inArray(s.xAccountsTable.platformUserId, [...xUsers]));
  }
  const now = await getXUsageToday();
  if (now && usageBefore !== undefined) {
    if (usageBefore) {
      const { day, ...rest } = usageBefore;
      await db.update(s.xApiUsageTable).set(rest).where(eq(s.xApiUsageTable.day, day));
    } else {
      await db.delete(s.xApiUsageTable).where(eq(s.xApiUsageTable.day, now.day));
    }
  }
}

let brainSource: { voice: unknown; interests: unknown; goals: unknown } | undefined;

/** A real, valid Scout Brain copied from a profile in the dev database. */
async function sourceBrain() {
  if (!brainSource) {
    const [row] = await db
      .select()
      .from(s.profilesTable)
      .where(isNotNull(s.profilesTable.voiceBrain))
      .limit(1);
    if (!row) throw new Error("Tests need one profile with a Scout Brain in the database.");
    brainSource = { voice: row.voiceBrain, interests: row.interestBrain, goals: row.goalBrain };
  }
  return brainSource;
}
