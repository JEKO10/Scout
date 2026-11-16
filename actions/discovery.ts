"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { requireProfile } from "@/lib/auth/session";
import { suggestKeywords } from "@/services/discovery/suggest";
import {
  createTopic,
  removeTopic,
  setTopicActive,
  type TopicInput,
  type TopicResult,
  updateTopic,
} from "@/services/discovery/topics";

// Smart Discovery topics: every action runs for the signed-in user only, and
// the services check ownership again in each query.

const idSchema = z.uuid();

export async function createTopicAction(input: TopicInput): Promise<TopicResult> {
  const { profile } = await requireProfile();
  const result = await createTopic(profile, input);
  if (result.ok) refresh();
  return result;
}

export async function updateTopicAction(id: string, input: TopicInput): Promise<TopicResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: "Topic not found." };
  const { profile } = await requireProfile();
  const result = await updateTopic(profile, id, input);
  if (result.ok) refresh();
  return result;
}

export async function setTopicActiveAction(id: string, active: boolean): Promise<TopicResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: "Topic not found." };
  const { profile } = await requireProfile();
  const result = await setTopicActive(profile, id, Boolean(active));
  if (result.ok) refresh();
  return result;
}

export async function deleteTopicAction(id: string): Promise<TopicResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: "Topic not found." };
  const { profile } = await requireProfile();
  const result = await removeTopic(profile, id);
  if (result.ok) refresh();
  return result;
}

const suggestSchema = z.object({
  name: z.string().trim().min(2, "Name the topic first.").max(60),
  description: z.string().trim().min(10, "Describe what you want to find in a sentence first.").max(400),
});

/** AI search terms for review: nothing is saved or searched */
export async function suggestKeywordsAction(input: z.input<typeof suggestSchema>) {
  const parsed = suggestSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, message: parsed.error.issues[0]?.message ?? "Describe the topic first." };
  const { profile } = await requireProfile();
  try {
    return await suggestKeywords(profile, parsed.data);
  } catch (error) {
    console.error("Keyword suggestion failed", error instanceof Error ? error.message : error);
    return { ok: false as const, message: "Couldn't suggest keywords right now. Add them by hand." };
  }
}
