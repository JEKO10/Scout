import { z } from "zod";

import type { Profile } from "@/db/schema";
import {
  type BrainListEdits,
  goalBrainSchema,
  interestBrainSchema,
  measuredVoiceSchema,
  voiceBrainSchema,
} from "@/lib/ai/schemas/scoutBrain";

export type BrainItem = {
  label: string;
  source: "ai" | "user";
  evidence?: "observed" | "stated" | "inferred";
  detail?: string;
};

const editsSchema = z.record(
  z.string(),
  z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
);

const storedSchema = <T extends z.ZodType>(data: T) =>
  z.object({
    data,
    edits: editsSchema,
    analyzedAt: z.string(),
    postCount: z.number(),
    // Brains analyzed before holdouts existed have none
    holdoutPostIds: z.array(z.string()).default([]),
    model: z.string(),
  });

const storedVoice = storedSchema(voiceBrainSchema).extend({
  // Missing on brains analyzed before style was measured
  measured: measuredVoiceSchema.optional(),
});
const storedInterests = storedSchema(interestBrainSchema);
const storedGoals = storedSchema(goalBrainSchema);

/** AI items minus what the user removed, plus what the user added. */
function applyEdits(
  aiItems: BrainItem[],
  edits: BrainListEdits | undefined,
  toUserItem: (label: string) => BrainItem = (label) => ({ label, source: "user" }),
): BrainItem[] {
  if (!edits) return aiItems;
  const removed = new Set(edits.removed.map((item) => item.toLowerCase()));
  const kept = aiItems.filter((item) => !removed.has(item.label.toLowerCase()));
  const existing = new Set(kept.map((item) => item.label.toLowerCase()));

  return [
    ...kept,
    ...edits.added
      .filter((label) => !existing.has(label.toLowerCase()))
      .map(toUserItem),
  ];
}

const aiItems = (labels: string[]): BrainItem[] =>
  labels.map((label) => ({ label, source: "ai" }));

/**
 * The effective Scout Brain: AI analysis with the user's edits applied.
 * Returns null until a valid analysis exists (e.g. before the first run, or
 * for brains stored in an older shape).
 */
export function resolveScoutBrain(profile: Profile) {
  const voice = storedVoice.safeParse(profile.voiceBrain);
  const interests = storedInterests.safeParse(profile.interestBrain);
  const goals = storedGoals.safeParse(profile.goalBrain);
  if (!voice.success || !interests.success || !goals.success) return null;

  const v = voice.data;
  const i = interests.data;
  const g = goals.data;

  return {
    analyzedAt: new Date(v.analyzedAt),
    postCount: v.postCount,
    holdoutPostIds: v.holdoutPostIds,
    model: v.model,
    voice: {
      ...v.data,
      measured: v.measured ?? null,
      tone: applyEdits(aiItems(v.data.tone), v.edits.tone),
      // detail carries the phrase's frequency (rare / occasional / frequent)
      signaturePhrases: applyEdits(
        v.data.signaturePhrases.map(({ phrase, frequency }) => ({
          label: phrase,
          source: "ai" as const,
          detail: frequency,
        })),
        v.edits.signaturePhrases,
        (label) => ({ label, source: "user", detail: "occasional" }),
      ),
      avoid: applyEdits(aiItems(v.data.avoid), v.edits.avoid),
    },
    interests: {
      ...i.data,
      topics: applyEdits(
        i.data.topics.map((topic) => ({
          label: topic.name,
          source: "ai" as const,
          evidence: topic.evidence,
          detail: `${topic.tier} · ${topic.postCount} posts · ${topic.confidence} confidence`,
        })),
        i.edits.topics,
        (label) => ({ label, source: "user", evidence: "stated", detail: "Added by you" }),
      ),
      recurringThemes: applyEdits(
        aiItems(i.data.recurringThemes),
        i.edits.recurringThemes,
      ),
    },
    goals: {
      ...g.data,
      targetAudience: applyEdits(
        aiItems(g.data.targetAudience),
        g.edits.targetAudience,
      ),
      knownFor: applyEdits(aiItems(g.data.knownFor), g.edits.knownFor),
    },
  };
}

export type ResolvedScoutBrain = NonNullable<ReturnType<typeof resolveScoutBrain>>;
