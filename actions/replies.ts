"use server";

import { refresh } from "next/cache";
import OpenAI from "openai";
import { z } from "zod";

import { addReplyRule, MAX_REPLY_RULES, removeReplyRule } from "@/db/queries/profiles";
import {
  type ReplySet,
  updateReplyContent,
} from "@/db/queries/replies";
import { requireProfile } from "@/lib/auth/session";
import { REPLY_STYLES } from "@/lib/replies/styles";
import { BUDGET_MESSAGES } from "@/services/billing/budget";
import { generateReplies } from "@/services/replies/generateReply";

const idSchema = z.uuid();

export type GenerateRepliesState =
  | { ok: true; replies: ReplySet }
  | { ok: false; message: string };

const instructionSchema = z
  .string()
  .trim()
  .max(300, "Keep the instruction under 300 characters.")
  .transform((value) => value || null);

const stylesSchema = z
  .tuple([z.enum(REPLY_STYLES), z.enum(REPLY_STYLES)])
  .refine(([first, second]) => first !== second, "Pick two different styles.");

/**
 * Generates two drafts in the styles the user picked. On regenerate the user
 * can say what to change ("shorter"), and with `remember` keep it as a rule
 * for every future reply.
 */
export async function generateRepliesAction(
  opportunityId: string,
  options: { styles: string[]; instruction?: string; remember?: boolean },
): Promise<GenerateRepliesState> {
  const { profile } = await requireProfile();
  const id = idSchema.safeParse(opportunityId);
  if (!id.success) return { ok: false, message: "Opportunity not found." };
  const instruction = instructionSchema.safeParse(options.instruction ?? "");
  if (!instruction.success) {
    return { ok: false, message: instruction.error.issues[0]?.message ?? "Check the instruction." };
  }
  const styles = stylesSchema.safeParse(options.styles);
  if (!styles.success) {
    return { ok: false, message: "Pick two different styles." };
  }

  try {
    if (instruction.data && options.remember === true) {
      await addReplyRule(profile.id, instruction.data);
    }
    const result = await generateReplies(profile.id, id.data, {
      styles: styles.data,
      instruction: instruction.data,
    });
    if (result.status === "not_found") {
      return { ok: false, message: "Opportunity not found." };
    }
    if (result.status === "budget_exhausted") {
      return { ok: false, message: BUDGET_MESSAGES.replies };
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

// Day 21: copying and opening X are recorded by recordReplyIntentAction
// (actions/replyIntents.ts), which never marks a reply as posted.

const ruleSchema = z
  .string()
  .trim()
  .min(2, "Write the rule first.")
  .max(300, "Keep the rule under 300 characters.");

export type ReplyRuleState = { status: "idle" | "success" | "error"; message?: string };

/** /memory: a standing rule for every reply, written directly. */
export async function addReplyRuleAction(
  _prev: ReplyRuleState,
  formData: FormData,
): Promise<ReplyRuleState> {
  const { profile } = await requireProfile();
  const rule = ruleSchema.safeParse(String(formData.get("rule") ?? ""));
  if (!rule.success) return { status: "error", message: rule.error.issues[0]?.message };

  const added = await addReplyRule(profile.id, rule.data);
  if (!added) {
    return {
      status: "error",
      message: `That rule is already there, or you have ${MAX_REPLY_RULES} rules. Remove one first.`,
    };
  }
  refresh();
  return { status: "success" };
}

export async function removeReplyRuleAction(rule: string): Promise<void> {
  const { profile } = await requireProfile();
  await removeReplyRule(profile.id, z.string().max(300).parse(rule));
  refresh();
}
