"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { addLeadActivity } from "@/db/queries/crm";
import { ensureLeadOpportunity, getLead } from "@/db/queries/leads";
import { requireProfile } from "@/lib/auth/session";
import { track } from "@/services/analytics/track";
import {
  addNote,
  changeLeadStatus,
  type CrmResult,
  editNote,
  finishFollowUp,
  logInteraction,
  removeLead,
  removeNote,
  saveLeadToCrm,
  scheduleFollowUp,
} from "@/services/leads/crm";
import { type LeadProfileInput, saveIcp, suggestIcp } from "@/services/leads/icp";

// Lead Scout: every action is for the signed-in user; queries check ownership.

const idSchema = z.uuid();

export async function saveIcpAction(input: LeadProfileInput) {
  const { profile } = await requireProfile();
  const result = await saveIcp(profile, input);
  if (result.ok) refresh();
  return result;
}

/** A draft from the Scout Brain for review: nothing is saved */
export async function suggestIcpAction() {
  const { profile } = await requireProfile();
  try {
    return await suggestIcp(profile);
  } catch (error) {
    console.error("ICP suggestion failed", error instanceof Error ? error.message : error);
    return { ok: false as const, message: "Couldn't draft a profile right now. Fill it in by hand." };
  }
}

export async function setLeadSavedAction(id: string, saved: boolean): Promise<CrmResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: "Lead not found." };
  const { profile } = await requireProfile();
  const result = await saveLeadToCrm(profile, id, Boolean(saved));
  if (result.ok && saved) await track("lead_saved", { profileId: profile.id });
  if (result.ok) refresh();
  return result;
}

/**
 * "Generate reply": replies use the opportunity flow (drafts, Reply on X,
 * Activity), so the lead gets an opportunity if it has none yet.
 */
export async function startLeadReplyAction(id: string): Promise<{ ok: true; href: string } | { ok: false; message: string }> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: "Lead not found." };
  const { profile } = await requireProfile();
  const lead = await getLead(profile.id, id);
  if (!lead) return { ok: false, message: "Lead not found." };
  const opportunityId = await ensureLeadOpportunity(profile.id, lead);
  if (!opportunityId) return { ok: false, message: "This post is no longer available for replies." };
  await addLeadActivity(profile.id, lead.id, "reply_started");
  await track("lead_reply_started", { profileId: profile.id });
  return { ok: true, href: `/opportunities/${opportunityId}` };
}

/** "Open on X": recorded as opened, never as contacted */
export async function leadOpenedAction(id: string): Promise<void> {
  if (!idSchema.safeParse(id).success) return;
  const { profile } = await requireProfile();
  if (await getLead(profile.id, id)) {
    // Opened, not contacted: the timeline says exactly that
    await addLeadActivity(profile.id, id, "x_opened");
    await track("lead_opened_on_x", { profileId: profile.id });
  }
}

// ---- Day 28 CRM ----------------------------------------------------------

async function withLead(id: string, run: (profile: Awaited<ReturnType<typeof requireProfile>>["profile"]) => Promise<CrmResult>) {
  if (!idSchema.safeParse(id).success) return { ok: false, message: "Not found." } satisfies CrmResult;
  const { profile } = await requireProfile();
  const result = await run(profile);
  if (result.ok) refresh();
  return result;
}

export async function setLeadStatusAction(id: string, status: string): Promise<CrmResult> {
  return withLead(id, (profile) => changeLeadStatus(profile, id, status));
}

export async function addLeadNoteAction(leadId: string, body: string): Promise<CrmResult> {
  return withLead(leadId, (profile) => addNote(profile, leadId, String(body)));
}

export async function editLeadNoteAction(noteId: string, body: string): Promise<CrmResult> {
  return withLead(noteId, (profile) => editNote(profile, noteId, String(body)));
}

export async function deleteLeadNoteAction(noteId: string): Promise<CrmResult> {
  return withLead(noteId, (profile) => removeNote(profile, noteId));
}

export async function setFollowUpAction(leadId: string, date: string | null, note?: string): Promise<CrmResult> {
  return withLead(leadId, (profile) => scheduleFollowUp(profile, leadId, { date: date || null, note }));
}

export async function completeFollowUpAction(leadId: string): Promise<CrmResult> {
  return withLead(leadId, (profile) => finishFollowUp(profile, leadId));
}

export async function logLeadInteractionAction(leadId: string, kind: "contact" | "response"): Promise<CrmResult> {
  if (kind !== "contact" && kind !== "response") return { ok: false, message: "Unknown action." };
  return withLead(leadId, (profile) => logInteraction(profile, leadId, kind));
}

export async function deleteLeadAction(leadId: string): Promise<CrmResult> {
  return withLead(leadId, (profile) => removeLead(profile, leadId));
}
