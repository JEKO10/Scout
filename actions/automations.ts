"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { markNotificationsRead, setItemStatus } from "@/db/queries/automations";
import { requireProfile } from "@/lib/auth/session";
import {
  createAutomation,
  editAutomation,
  enableGrowthPlanReminders,
  removeAutomation,
  toggleAutomation,
} from "@/services/automations/manage";

type ActionResult = { ok: boolean; message: string };

const id = z.uuid();

/** Builder "Create": validated server-side (lib/automations/rules.ts) */
export async function createAutomationAction(input: unknown): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const result = await createAutomation(profile, input);
  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: "Automation saved." };
}

export async function editAutomationAction(automationId: string, input: unknown): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = id.safeParse(automationId);
  if (!parsed.success) return { ok: false, message: "Automation not found." };
  const result = await editAutomation(profile, parsed.data, input);
  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: "Automation updated." };
}

export async function toggleAutomationAction(automationId: string, enabled: boolean): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = id.safeParse(automationId);
  if (!parsed.success || typeof enabled !== "boolean") return { ok: false, message: "Automation not found." };
  const result = await toggleAutomation(profile, parsed.data, enabled);
  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: enabled ? "Turned on." : "Turned off." };
}

export async function deleteAutomationAction(automationId: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = id.safeParse(automationId);
  if (!parsed.success) return { ok: false, message: "Automation not found." };
  const result = await removeAutomation(profile, parsed.data);
  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: "Automation deleted." };
}

const itemStatus = z.enum(["reviewed", "dismissed", "done"]);

/** Review queue: reviewed, dismissed, or a reminder done (its notification is marked read too) */
export async function setReviewItemAction(itemId: string, status: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsedId = id.safeParse(itemId);
  const parsedStatus = itemStatus.safeParse(status);
  if (!parsedId.success || !parsedStatus.success) return { ok: false, message: "Invalid request." };
  if (!(await setItemStatus(profile.id, parsedId.data, parsedStatus.data))) return { ok: false, message: "Item not found." };
  refresh();
  return { ok: true, message: "Updated." };
}

export async function markAutomationNotificationsReadAction(notificationId?: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  if (notificationId !== undefined && !id.safeParse(notificationId).success) return { ok: false, message: "Invalid request." };
  await markNotificationsRead(profile.id, notificationId);
  refresh();
  return { ok: true, message: "Marked read." };
}

/** From /strategy: reminders for the weekly plan's tasks (no AI, no X) */
export async function enableGrowthPlanRemindersAction(): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const result = await enableGrowthPlanReminders(profile);
  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: "Reminders are on: you'll see each task in Automations on its day." };
}
