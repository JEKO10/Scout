import "server-only";

import { getProfileById, saveLearningProfile } from "@/db/queries/profiles";
import type { LearningProfile } from "@/lib/scout/learning";
import { buildUserMemory, type UserMemory } from "@/services/memory/buildUserMemory";

import { learnFromHistory, shouldRelearn } from "./learnFromHistory";

/**
 * Current Memory plus the Learning Profile, re-learned only when ~10 new
 * interactions have happened since the last update (or when forced by the
 * user's "Update learning"). Not after every click: preferences change slowly.
 */
export async function refreshLearning(
  profileId: string,
  { force = false }: { force?: boolean } = {},
): Promise<{ memory: UserMemory; learning: LearningProfile | null; updated: boolean }> {
  const [profile, memory] = await Promise.all([
    getProfileById(profileId),
    buildUserMemory(profileId),
  ]);
  const current = profile?.learningProfile ?? null;

  if (!force && !shouldRelearn(memory, current)) {
    return { memory, learning: current, updated: false };
  }
  const learning = learnFromHistory(memory, current, new Date());
  await saveLearningProfile(profileId, learning);
  return { memory, learning, updated: true };
}

/** "That's wrong": drop a conclusion now and never learn it again. */
export async function rejectLearnedItem(profileId: string, key: string): Promise<void> {
  const profile = await getProfileById(profileId);
  const current = profile?.learningProfile;
  if (!current) return;

  const keep = <T extends { key: string }>(items: T[]) => items.filter((item) => item.key !== key);
  await saveLearningProfile(profileId, {
    ...current,
    preferredReplyLength:
      current.preferredReplyLength?.key === key ? null : current.preferredReplyLength,
    variantPreference: current.variantPreference?.key === key ? null : current.variantPreference,
    stylePreferences: keep(current.stylePreferences),
    styleAvoidances: keep(current.styleAvoidances),
    preferredTopics: keep(current.preferredTopics),
    avoidedTopics: keep(current.avoidedTopics),
    overusedAngles: keep(current.overusedAngles),
    preferredAccounts: keep(current.preferredAccounts),
    rejectedKeys: [...new Set([...current.rejectedKeys, key])],
  });
}
