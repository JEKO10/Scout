"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { requireProfile } from "@/lib/auth/session";
import {
  approveForPublishing,
  deletePublished,
  type PublishOutcome,
  publishPublication,
  type PublishResult,
  schedulePublication,
  unschedulePublication,
} from "@/services/x/publishing";

// Day 40 X publishing. Every action re-reads the profile from the session;
// the service checks that the publication is this profile's, the approval
// still matches the text, and the connection may publish.

const id = z.uuid();
const failed = { ok: false as const, message: "Something went wrong. Try again." };

async function safely<T>(run: () => Promise<T>): Promise<T | typeof failed> {
  try {
    return await run();
  } catch (error) {
    console.error("Publishing action failed", error instanceof Error ? error.message : error);
    return failed;
  }
}

/** Approves the draft's saved text for publishing (Studio and Calendar) */
export async function approveForPublishingAction(draftId: string): Promise<PublishResult> {
  const { profile } = await requireProfile();
  if (!id.safeParse(draftId).success) return { ok: false, message: "Invalid request." };
  const result = await safely(() => approveForPublishing(profile, draftId));
  if (result.ok) refresh();
  return result.ok ? { ok: true } : result;
}

/** "Publish now": one POST to X with the approved text */
export async function publishNowAction(publicationId: string): Promise<PublishOutcome> {
  const { profile } = await requireProfile();
  if (!id.safeParse(publicationId).success) return { ok: false, message: "Invalid request." };
  return safely(() => publishPublication(profile, publicationId, { mode: "now" }));
}

export async function schedulePublicationAction(publicationId: string, input: { date: string; time: string; timeZone: string }): Promise<PublishResult> {
  const { profile } = await requireProfile();
  if (!id.safeParse(publicationId).success) return { ok: false, message: "Invalid request." };
  const result = await safely(() => schedulePublication(profile, publicationId, input));
  if (result.ok) refresh();
  return result.ok ? { ok: true } : result;
}

export async function unschedulePublicationAction(publicationId: string): Promise<PublishResult> {
  const { profile } = await requireProfile();
  if (!id.safeParse(publicationId).success) return { ok: false, message: "Invalid request." };
  const result = await safely(() => unschedulePublication(profile, publicationId));
  if (result.ok) refresh();
  return result;
}

/** "Delete from X" for a post Scout published */
export async function deletePublishedAction(publicationId: string): Promise<PublishResult> {
  const { profile } = await requireProfile();
  if (!id.safeParse(publicationId).success) return { ok: false, message: "Invalid request." };
  const result = await safely(() => deletePublished(profile, publicationId));
  if (result.ok) refresh();
  return result;
}
