"use server";

import { refresh } from "next/cache";
import OpenAI from "openai";
import { z } from "zod";

import { resetInboxLearning, setAutoPrepare } from "@/db/queries/inbox";
import { requireProfile } from "@/lib/auth/session";
import {
  actOnItem,
  type ActOutcome,
  decideRevision,
  INBOX_ACTIONS,
  type InboxResult,
  preparePost,
  recordDeclineReason,
  reviseText,
  saveText,
} from "@/services/inbox/inbox";

// Day 38 Approval Inbox. Every action re-reads the profile from the session
// and the service checks ownership of what the key points at.

const keySchema = z.string().min(5).max(120);

/** Paid AI calls: a failure becomes a short message, never a stack trace */
async function safely<T>(run: () => Promise<InboxResult<T>>): Promise<InboxResult<T>> {
  try {
    return await run();
  } catch (error) {
    console.error("Inbox action failed", error instanceof Error ? error.message : error);
    return {
      ok: false,
      message: error instanceof OpenAI.APIError && error.status === 429 ? "The AI service is busy. Try again shortly." : "Something went wrong. Try again.",
    };
  }
}

export async function inboxActAction(key: string, action: string): Promise<InboxResult<ActOutcome>> {
  const { profile } = await requireProfile();
  const parsedKey = keySchema.safeParse(key);
  const parsedAction = z.enum(INBOX_ACTIONS).safeParse(action);
  if (!parsedKey.success || !parsedAction.success) return { ok: false, message: "Invalid request." };
  const result = await safely(() => actOnItem(profile, parsedKey.data, parsedAction.data));
  // Approvals stay on screen with their outcome (copy / open X); the rest re-render the Inbox
  if (result.ok && parsedAction.data !== "approve") refresh();
  return result;
}

export async function inboxDeclineReasonAction(key: string, reason: string): Promise<InboxResult> {
  const { profile } = await requireProfile();
  if (!keySchema.safeParse(key).success) return { ok: false, message: "Invalid request." };
  return recordDeclineReason(profile, key, reason);
}

/** Autosave while editing (no refresh: the editor keeps its state) */
export async function inboxSaveTextAction(key: string, text: string): Promise<InboxResult> {
  const { profile } = await requireProfile();
  if (!keySchema.safeParse(key).success || typeof text !== "string") return { ok: false, message: "Invalid request." };
  return saveText(profile, key, text);
}

const reviseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("quick"), edit: z.string().max(20) }),
  z.object({ type: z.literal("custom"), instruction: z.string().max(300) }),
  z.object({ type: z.literal("regenerate") }),
]);

/** One AI edit or regeneration, returned as a preview (writing budget) */
export async function inboxReviseAction(key: string, request: unknown, currentText: string) {
  const { profile } = await requireProfile();
  const parsed = reviseSchema.safeParse(request);
  if (!keySchema.safeParse(key).success || !parsed.success || typeof currentText !== "string") {
    return { ok: false as const, message: "Invalid request." };
  }
  return safely(() => reviseText(profile, key, parsed.data, currentText));
}

export async function inboxDecideRevisionAction(revisionId: string, accept: boolean) {
  const { profile } = await requireProfile();
  return decideRevision(profile, revisionId, accept === true);
}

/** "Write me a post": one draft now, from the writing budget (the user asked for it) */
export async function inboxWritePostAction(): Promise<InboxResult<{ draftId: string; already?: boolean }>> {
  const { profile } = await requireProfile();
  const result = await safely(() => preparePost(profile));
  if (result.ok) refresh();
  return result;
}

export async function setAutoPrepareAction(enabled: boolean): Promise<InboxResult> {
  const { profile } = await requireProfile();
  await setAutoPrepare(profile.id, enabled === true);
  refresh();
  return { ok: true };
}

export async function resetInboxLearningAction(): Promise<InboxResult> {
  const { profile } = await requireProfile();
  await resetInboxLearning(profile.id);
  refresh();
  return { ok: true };
}
