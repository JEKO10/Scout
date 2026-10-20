import "server-only";

import { eq } from "drizzle-orm";

import db from "@/db";
import { type Profile, profilesTable } from "@/db/schema";

export async function getProfileByUserId(
  userId: string,
): Promise<Profile | undefined> {
  return db.query.profilesTable.findFirst({ where: { userId } });
}

/**
 * Returns the Scout profile for a Neon Auth user, creating it on first access.
 * `userId` must come from the server-side session, never from the client.
 */
export async function getOrCreateProfile(userId: string): Promise<Profile> {
  const existing = await getProfileByUserId(userId);
  if (existing) return existing;

  // Two concurrent requests can both miss the read above. The UNIQUE(userId)
  // constraint lets only one insert win; the loser gets no row back and
  // re-reads the winner's row instead of throwing.
  const [created] = await db
    .insert(profilesTable)
    .values({ userId })
    .onConflictDoNothing({ target: profilesTable.userId })
    .returning();
  if (created) return created;

  const profile = await getProfileByUserId(userId);
  if (!profile) throw new Error(`Failed to get or create profile for ${userId}`);
  return profile;
}

export async function updateProfileByUserId(
  userId: string,
  values: Partial<
    Pick<
      Profile,
      | "displayName"
      | "occupation"
      | "bio"
      | "targetAudience"
      | "primaryGoal"
      | "knownFor"
      | "onboardingCompleted"
    >
  >,
): Promise<Profile> {
  await getOrCreateProfile(userId);
  const [profile] = await db
    .update(profilesTable)
    .set(values)
    .where(eq(profilesTable.userId, userId))
    .returning();
  return profile;
}
