"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { requireProfile } from "@/lib/auth/session";
import { refreshLearning, rejectLearnedItem } from "@/services/learning/refreshLearning";

/** Manual "Update learning": re-learn now instead of waiting for 10 new interactions. */
export async function updateLearningAction(): Promise<void> {
  const { profile } = await requireProfile();
  await refreshLearning(profile.id, { force: true });
  refresh();
}

const keySchema = z.string().min(1).max(200);

/** "That's wrong": remove a conclusion and never learn it again. */
export async function rejectLearnedItemAction(key: string): Promise<void> {
  const { profile } = await requireProfile();
  await rejectLearnedItem(profile.id, keySchema.parse(key));
  refresh();
}
