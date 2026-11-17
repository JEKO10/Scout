"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { getDraft } from "@/db/queries/content";
import { requireProfile } from "@/lib/auth/session";
import { track } from "@/services/analytics/track";
import { planDraft, savePublishedUrl, setArchived, unplanDraft } from "@/services/content/calendar";
import {
  confirmPublished,
  createDraft,
  duplicateDraft,
  type editSchema,
  generateIdeas,
  type ideasInputSchema,
  regenerateDraft,
  removeDraft,
  reviewDraft,
  rewritePost,
  saveDraftEdits,
  type writeInputSchema,
} from "@/services/content/studio";

// Content Studio: every action runs for the signed-in user; the service checks
// ownership, budget and pacing again. AI runs only on these explicit requests.

const idSchema = z.uuid();
const failed = { ok: false as const, message: "Something went wrong. Try again in a moment." };

async function safely<T>(run: () => Promise<T>): Promise<T | typeof failed> {
  try {
    return await run();
  } catch (error) {
    console.error("Content Studio failed", error instanceof Error ? error.message : error);
    return failed;
  }
}

export async function generateIdeasAction(input: z.input<typeof ideasInputSchema>) {
  const { profile } = await requireProfile();
  return safely(() => generateIdeas(profile, input));
}

export async function createDraftAction(input: z.input<typeof writeInputSchema>) {
  const { profile } = await requireProfile();
  return safely(() => createDraft(profile, input));
}

export async function regenerateDraftAction(draftId: string) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  const result = await safely(() => regenerateDraft(profile, draftId));
  if (result.ok) refresh();
  return result;
}

export async function rewritePostAction(draftId: string, index: number, action: string, tone?: string) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  return safely(() => rewritePost(profile, draftId, Number(index), action, tone));
}

export async function reviewDraftAction(draftId: string) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  return safely(() => reviewDraft(profile, draftId));
}

export async function saveDraftAction(draftId: string, input: z.input<typeof editSchema>) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  const result = await saveDraftEdits(profile, draftId, input);
  if (result.ok) refresh();
  return result;
}

export async function duplicateDraftAction(draftId: string) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  return duplicateDraft(profile, draftId);
}

export async function deleteDraftAction(draftId: string) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  const result = await removeDraft(profile, draftId);
  if (result.ok) refresh();
  return result;
}

export async function confirmPublishedAction(draftId: string) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  const result = await confirmPublished(profile, draftId);
  if (result.ok) refresh();
  return result;
}

/** Copied or opened on X: recorded as exactly that, never as published */
export async function contentHandoffAction(draftId: string, kind: "copied" | "opened"): Promise<void> {
  if (!idSchema.safeParse(draftId).success || (kind !== "copied" && kind !== "opened")) return;
  const { profile } = await requireProfile();
  if (await getDraft(profile.id, draftId)) {
    await track(kind === "copied" ? "content_copied" : "content_opened_on_x", { profileId: profile.id });
  }
}

// ---- Day 32 Content Calendar ---------------------------------------------------

export async function planDraftAction(
  draftId: string,
  input: { date: string; time: string; timeZone: string; goal?: string; note?: string },
) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  const result = await planDraft(profile, draftId, input as Parameters<typeof planDraft>[2]);
  if (result.ok) refresh();
  return result;
}

export async function unplanDraftAction(draftId: string) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  const result = await unplanDraft(profile, draftId);
  if (result.ok) refresh();
  return result;
}

export async function archiveDraftAction(draftId: string, archived: boolean) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  const result = await setArchived(profile, draftId, Boolean(archived));
  if (result.ok) refresh();
  return result;
}

export async function savePublishedUrlAction(draftId: string, url: string) {
  if (!idSchema.safeParse(draftId).success) return { ok: false as const, message: "Draft not found." };
  const { profile } = await requireProfile();
  const result = await savePublishedUrl(profile, draftId, String(url ?? ""));
  if (result.ok) refresh();
  return result;
}
