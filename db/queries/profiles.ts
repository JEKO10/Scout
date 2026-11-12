import "server-only";

import { and, eq, sql } from "drizzle-orm";

import db from "@/db";
import { type Profile, profilesTable } from "@/db/schema";
import type {
  BrainListEdits,
  BrainName,
  MeasuredVoice,
  ScoutBrainAnalysis,
} from "@/lib/ai/schemas/scoutBrain";
import type { LearningProfile } from "@/lib/scout/learning";
import type { ReplyPreferences } from "@/lib/scout/replyPreferences";

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
      | "topics"
      | "avoidTopics"
      | "voiceDescription"
      | "onboardingCompleted"
      | "opportunitySensitivity"
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
    holdoutPostIds,
    model,
    measured,
    basis = "posts",
  }: {
    analysis: ScoutBrainAnalysis;
    measured: MeasuredVoice;
    basis?: "posts" | "onboarding";
    postCount: number;
    holdoutPostIds: string[];
    model: string;
  },
): Promise<void> {
  const profile = await getProfileById(profileId);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const meta = {
    analyzedAt: new Date().toISOString(),
    postCount,
    holdoutPostIds,
    model,
    basis,
  };

  await db
    .update(profilesTable)
    .set({
      voiceBrain: {
        data: analysis.voice,
        edits: profile.voiceBrain?.edits ?? {},
        measured,
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

export async function saveLearningProfile(
  profileId: string,
  learningProfile: LearningProfile,
): Promise<void> {
  await db
    .update(profilesTable)
    .set({ learningProfile })
    .where(eq(profilesTable.id, profileId));
}

/** Most standing rules a profile keeps; each one goes into every reply prompt. */
export const MAX_REPLY_RULES = 20;

/**
 * Adds a standing reply rule. Returns false when it's already there or the
 * profile has MAX_REPLY_RULES; both checks are part of the update itself.
 */
export async function addReplyRule(profileId: string, rule: string): Promise<boolean> {
  const updated = await db
    .update(profilesTable)
    .set({ replyRules: sql`array_append(${profilesTable.replyRules}, ${rule})` })
    .where(
      and(
        eq(profilesTable.id, profileId),
        sql`not (${rule} = any(${profilesTable.replyRules}))`,
        sql`cardinality(${profilesTable.replyRules}) < ${MAX_REPLY_RULES}`,
      ),
    )
    .returning({ id: profilesTable.id });
  return updated.length > 0;
}

export async function removeReplyRule(profileId: string, rule: string): Promise<void> {
  await db
    .update(profilesTable)
    .set({ replyRules: sql`array_remove(${profilesTable.replyRules}, ${rule})` })
    .where(eq(profilesTable.id, profileId));
}

/**
 * Automatic Scout on or off, and how often. Turning it on schedules a scan
 * right away; turning it off clears the schedule (an open job then skips).
 */
/** Settings: the user's own reply preferences. Never written by Brain analysis. */
export async function saveReplyPreferences(
  profileId: string,
  preferences: ReplyPreferences,
): Promise<void> {
  await db
    .update(profilesTable)
    .set({ replyPreferences: preferences })
    .where(eq(profilesTable.id, profileId));
}

export async function updateAutoScan(
  profileId: string,
  { enabled, intervalMinutes }: { enabled: boolean; intervalMinutes: number },
): Promise<void> {
  await db
    .update(profilesTable)
    .set({
      autoScanEnabled: enabled,
      autoScanIntervalMinutes: intervalMinutes,
      nextScanAt: enabled
        ? sql`case when ${profilesTable.autoScanEnabled} then coalesce(${profilesTable.nextScanAt}, now()) else now() end`
        : null,
    })
    .where(eq(profilesTable.id, profileId));
}
