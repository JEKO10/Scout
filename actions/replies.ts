"use server";

import OpenAI from "openai";
import { z } from "zod";

import {
  markReplyCopied,
  type ReplyPair,
  updateReplyContent,
} from "@/db/queries/replies";
import { requireProfile } from "@/lib/auth/session";
import { generateReplies } from "@/services/replies/generateReply";

const idSchema = z.uuid();

export type GenerateRepliesState =
  | { ok: true; replies: ReplyPair }
  | { ok: false; message: string };

export async function generateRepliesAction(
  opportunityId: string,
): Promise<GenerateRepliesState> {
  const { profile } = await requireProfile();
  const id = idSchema.safeParse(opportunityId);
  if (!id.success) return { ok: false, message: "Opportunity not found." };

  try {
    const result = await generateReplies(profile.id, id.data);
    if (result.status === "not_found") {
      return { ok: false, message: "Opportunity not found." };
    }
    if (result.status === "no_brain") {
      return { ok: false, message: "Analyze your profile first; replies need your Scout Brain." };
    }
    return { ok: true, replies: result.replies };
  } catch (error) {
    console.error("Reply generation failed", error);
    return {
      ok: false,
      message:
        error instanceof OpenAI.APIError && error.status === 429
          ? "The AI service is busy or out of credits. Try again shortly."
          : "Couldn't generate replies. Try again.",
    };
  }
}

const editSchema = z.object({
  replyId: z.uuid(),
  // A little over X's limit so a long draft can still be trimmed in place
  content: z.string().trim().min(1, "A reply can't be empty.").max(1000),
});

export async function editReplyAction(
  replyId: string,
  content: string,
): Promise<{ ok: boolean; message?: string }> {
  const { profile } = await requireProfile();
  const parsed = editSchema.safeParse({ replyId, content });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message };
  }
  const reply = await updateReplyContent(profile.id, parsed.data.replyId, parsed.data.content);
  return reply ? { ok: true } : { ok: false, message: "Reply not found." };
}

/** Called after the browser copied the text; records the user's pick. */
export async function markReplyCopiedAction(replyId: string): Promise<{ ok: boolean }> {
  const { profile } = await requireProfile();
  const id = idSchema.safeParse(replyId);
  if (!id.success) return { ok: false };
  return { ok: await markReplyCopied(profile.id, id.data) };
}
