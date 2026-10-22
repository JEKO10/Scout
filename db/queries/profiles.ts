import "server-only";

import { eq } from "drizzle-orm";

import db from "@/db";
import { type Profile, profilesTable } from "@/db/schema";
import type {
  BrainListEdits,
  BrainName,
  ScoutBrainAnalysis,
} from "@/lib/ai/schemas/scoutBrain";

export async function getProfileByUserId(
  userId: string,
): Promise<Profile | undefined> {
  return db.query.profilesTable.findFirst({ where: { userId } });
}

export async function getProfileById(
  id: string,
): Promise<Profile | undefined> {
  return db.query.profilesTable.findFirst({ where: { id } });
}

export async function updateProfileXHandle(
  id: string,
  xHandle: string,
): Promise<void> {
  await db
    .update(profilesTable)
    .set({ xHandle })
    .where(eq(profilesTable.id, id));
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
      | "xHandle"
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

/** Stores a fresh AI analysis while keeping the user's existing edits. */
export async function updateProfileBrain(
  profileId: string,
  {
    analysis,
    postCount,
    model,
  }: { analysis: ScoutBrainAnalysis; postCount: number; model: string },
): Promise<void> {
  const profile = await getProfileById(profileId);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const meta = { analyzedAt: new Date().toISOString(), postCount, model };

  await db
    .update(profilesTable)
    .set({
      voiceBrain: {
        data: analysis.voice,
        edits: profile.voiceBrain?.edits ?? {},
        ...meta,
      },
      interestBrain: {
        data: analysis.interests,
        edits: profile.interestBrain?.edits ?? {},
        ...meta,
      },
      goalBrain: {
        data: analysis.goals,
        edits: profile.goalBrain?.edits ?? {},
        ...meta,
      },
    })
    .where(eq(profilesTable.id, profileId));
}

const brainColumns = {
  voice: "voiceBrain",
  interests: "interestBrain",
  goals: "goalBrain",
} as const;

/** Adds or removes one item in a brain list, recorded as a user edit. */
export async function updateBrainListEdit(
  profileId: string,
  brain: BrainName,
  list: string,
  op: "add" | "remove",
  value: string,
): Promise<void> {
  const profile = await getProfileById(profileId);
  const column = brainColumns[brain];
  const stored = profile?.[column];
  if (!stored) throw new Error("Analyze the Scout Brain before editing it.");

  const edits: Record<string, BrainListEdits> = { ...stored.edits };
  const current = edits[list] ?? { added: [], removed: [] };
  const key = value.toLowerCase();
  const without = (items: string[]) =>
    items.filter((item) => item.toLowerCase() !== key);

  edits[list] =
    op === "add"
      ? { added: [...without(current.added), value], removed: without(current.removed) }
      : // Removing a user-added item just undoes the add
        current.added.some((item) => item.toLowerCase() === key)
        ? { added: without(current.added), removed: current.removed }
        : { added: current.added, removed: [...without(current.removed), value] };

  await db
    .update(profilesTable)
    .set({ [column]: { ...stored, edits } })
    .where(eq(profilesTable.id, profileId));
}
