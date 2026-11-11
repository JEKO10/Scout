import "server-only";

import { and, asc, eq } from "drizzle-orm";

import db from "@/db";
import { type VoiceSample, voiceSamplesTable } from "@/db/schema";

export async function getVoiceSamples(profileId: string): Promise<VoiceSample[]> {
  return db
    .select()
    .from(voiceSamplesTable)
    .where(eq(voiceSamplesTable.profileId, profileId))
    .orderBy(asc(voiceSamplesTable.createdAt));
}

/** Re-calibrating replaces the onboarding samples; nothing else is touched. */
export async function replaceOnboardingSamples(
  profileId: string,
  samples: { promptPost: string; userReply: string }[],
): Promise<void> {
  const remove = db
    .delete(voiceSamplesTable)
    .where(
      and(
        eq(voiceSamplesTable.profileId, profileId),
        eq(voiceSamplesTable.source, "onboarding"),
      ),
    );
  if (samples.length === 0) {
    await remove;
    return;
  }
  await db.batch([
    remove,
    db
      .insert(voiceSamplesTable)
      .values(samples.map((sample) => ({ profileId, source: "onboarding" as const, ...sample }))),
  ]);
}

/** A take the user wrote down to teach Scout ("Teach Scout more"). */
export async function addOpinionSample(
  profileId: string,
  promptPost: string,
  userReply: string,
): Promise<VoiceSample> {
  const [sample] = await db
    .insert(voiceSamplesTable)
    .values({ profileId, source: "opinion", promptPost, userReply })
    .returning();
  return sample;
}

export async function deleteVoiceSample(profileId: string, sampleId: string): Promise<void> {
  await db
    .delete(voiceSamplesTable)
    .where(and(eq(voiceSamplesTable.id, sampleId), eq(voiceSamplesTable.profileId, profileId)));
}
