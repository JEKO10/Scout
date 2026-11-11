// Temporary profiles in the real development database, deleted after each
// test file, plus a restore of the global X usage counter they touch.
import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import db from "@/db";
import { getXUsageToday } from "@/db/queries/xApiUsage";
import * as s from "@/db/schema";
import type { UsageLimits } from "@/lib/billing/plans";

const created: string[] = [];
let usageBefore: Awaited<ReturnType<typeof getXUsageToday>> | null | undefined;

export async function rememberXUsage() {
  usageBefore = (await getXUsageToday()) ?? null;
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

/** Watched with a cursor already set, so each scan reads at most a page of new posts. */
export async function watch(profileId: string, userIds: string[], { cursor = true } = {}) {
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

export async function watchedCursor(profileId: string, userId: string) {
  const [row] = await db
    .select()
    .from(s.watchlistAccountsTable)
    .where(
      and(
        eq(s.watchlistAccountsTable.profileId, profileId),
        eq(s.watchlistAccountsTable.platformUserId, userId),
      ),
    );
  return row?.xCursor;
}

export async function cleanup() {
  if (created.length) {
    await db.delete(s.profilesTable).where(inArray(s.profilesTable.id, created));
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
