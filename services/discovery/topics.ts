import "server-only";

import { z } from "zod";

import {
  countActiveDiscoveryTopics,
  countDiscoveryTopics,
  deleteDiscoveryTopic,
  insertDiscoveryTopic,
  setDiscoveryTopicActive,
  updateDiscoveryTopic,
} from "@/db/queries/discovery";
import type { Profile } from "@/db/schema";
import { effectiveLimits } from "@/lib/billing/plans";
import { cleanKeywords, MAX_EXCLUDED, MAX_KEYWORDS } from "@/lib/discovery/query";

/** Saved topics, active or paused: a plain cap against clutter */
export const MAX_SAVED_TOPICS = 20;

export const topicSchema = z.object({
  name: z.string().trim().min(2, "Give the topic a name.").max(60),
  description: z.string().trim().max(400).optional(),
  keywords: z.array(z.string()).max(30),
  excludedKeywords: z.array(z.string()).max(30).default([]),
});

export type TopicInput = z.input<typeof topicSchema>;
export type TopicResult = { ok: true; message?: string } | { ok: false; message: string };

type Parsed =
  | { ok: false; message: string }
  | { ok: true; values: { name: string; description: string | null; keywords: string[]; excludedKeywords: string[] } };

function parse(input: TopicInput): Parsed {
  const parsed = topicSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the topic." };
  const keywords = cleanKeywords(parsed.data.keywords, MAX_KEYWORDS);
  if (keywords.length === 0) return { ok: false, message: "Add at least one keyword to search for." };
  return {
    ok: true,
    values: {
      name: parsed.data.name,
      description: parsed.data.description || null,
      keywords,
      excludedKeywords: cleanKeywords(parsed.data.excludedKeywords, MAX_EXCLUDED),
    },
  };
}

const maxActive = (profile: Pick<Profile, "plan" | "usageLimitOverrides">) =>
  effectiveLimits(profile.plan, profile.usageLimitOverrides).maxDiscoveryTopics;

/** A new topic is active if the plan allows another one, paused otherwise. Never searched right away. */
export async function createTopic(profile: Profile, input: TopicInput): Promise<TopicResult> {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;
  if ((await countDiscoveryTopics(profile.id)) >= MAX_SAVED_TOPICS) {
    return { ok: false, message: `You can save up to ${MAX_SAVED_TOPICS} topics. Delete one first.` };
  }
  const active = (await countActiveDiscoveryTopics(profile.id)) < maxActive(profile);
  await insertDiscoveryTopic(profile.id, { ...parsed.values, isActive: active });
  return {
    ok: true,
    message: active
      ? "Topic saved. Scout searches it in your next scan."
      : `Topic saved as paused: your plan searches ${maxActive(profile)} active ${maxActive(profile) === 1 ? "topic" : "topics"} at a time.`,
  };
}

export async function updateTopic(profile: Profile, id: string, input: TopicInput): Promise<TopicResult> {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;
  return (await updateDiscoveryTopic(profile.id, id, parsed.values))
    ? { ok: true, message: "Topic updated." }
    : { ok: false, message: "Topic not found." };
}

export async function setTopicActive(profile: Profile, id: string, active: boolean): Promise<TopicResult> {
  if (active && (await countActiveDiscoveryTopics(profile.id)) >= maxActive(profile)) {
    return {
      ok: false,
      message: `Your plan searches ${maxActive(profile)} active ${maxActive(profile) === 1 ? "topic" : "topics"} at a time. Pause another first.`,
    };
  }
  return (await setDiscoveryTopicActive(profile.id, id, active))
    ? { ok: true }
    : { ok: false, message: "Topic not found." };
}

export async function removeTopic(profile: Profile, id: string): Promise<TopicResult> {
  return (await deleteDiscoveryTopic(profile.id, id)) ? { ok: true } : { ok: false, message: "Topic not found." };
}
