import "server-only";

import { z } from "zod";

import {
  addLeadActivity,
  completeLeadFollowUp,
  countSavedLeads,
  deleteLead,
  deleteLeadNote,
  getCrmLead,
  insertLeadNote,
  setLeadFollowUp,
  setLeadSavedFlag,
  setLeadStatus,
  updateLeadNote,
} from "@/db/queries/crm";
import type { Profile } from "@/db/schema";
import { effectiveLimits } from "@/lib/billing/plans";
import { LEAD_STATUSES, type LeadStatus, STATUS_LABEL } from "@/lib/leads/crm";

export type CrmResult = { ok: true; message?: string } | { ok: false; message: string };

const NOT_FOUND: CrmResult = { ok: false, message: "Lead not found." };

/** Save to (or remove from) the CRM. Removing keeps status, notes and history. */
export async function saveLeadToCrm(profile: Profile, leadId: string, saved: boolean): Promise<CrmResult> {
  const current = await getCrmLead(profile.id, leadId);
  if (!current) return NOT_FOUND;
  if (saved && !current.lead.saved) {
    const max = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxSavedLeads;
    if ((await countSavedLeads(profile.id)) >= max) {
      return { ok: false, message: `Your plan keeps up to ${max} leads in the CRM. Remove one first.` };
    }
  }
  if (current.lead.saved === saved) return { ok: true };
  await setLeadSavedFlag(profile.id, leadId, saved);
  if (saved) await addLeadActivity(profile.id, leadId, "saved");
  return { ok: true, message: saved ? "Saved to your CRM." : "Removed from your CRM. Notes and history are kept." };
}

const statusSchema = z.enum(LEAD_STATUSES);

export async function changeLeadStatus(profile: Profile, leadId: string, status: string): Promise<CrmResult> {
  const parsed = statusSchema.safeParse(status);
  if (!parsed.success) return { ok: false, message: "Unknown status." };
  const current = await getCrmLead(profile.id, leadId);
  if (!current) return NOT_FOUND;
  if (current.lead.status === parsed.data) return { ok: true };
  await setLeadStatus(profile.id, leadId, parsed.data);
  // The user's own judgment: shown as user-entered in the timeline
  await addLeadActivity(profile.id, leadId, "status_changed", {
    userEntered: true,
    detail: { from: current.lead.status, to: parsed.data },
  });
  return { ok: true, message: `Moved to ${STATUS_LABEL[parsed.data as LeadStatus]}.` };
}

const noteSchema = z.string().trim().min(1, "Write something first.").max(4000, "Keep notes under 4,000 characters.");

export async function addNote(profile: Profile, leadId: string, body: string): Promise<CrmResult> {
  const parsed = noteSchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the note." };
  if (!(await getCrmLead(profile.id, leadId))) return NOT_FOUND;
  await insertLeadNote(profile.id, leadId, parsed.data);
  await addLeadActivity(profile.id, leadId, "note_added", { userEntered: true });
  return { ok: true };
}

export async function editNote(profile: Profile, noteId: string, body: string): Promise<CrmResult> {
  const parsed = noteSchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the note." };
  return (await updateLeadNote(profile.id, noteId, parsed.data)) ? { ok: true } : { ok: false, message: "Note not found." };
}

export async function removeNote(profile: Profile, noteId: string): Promise<CrmResult> {
  return (await deleteLeadNote(profile.id, noteId)) ? { ok: true } : { ok: false, message: "Note not found." };
}

const followUpSchema = z.object({
  date: z.iso.date().nullable(),
  note: z.string().trim().max(300).optional(),
});

/** A follow-up date (YYYY-MM-DD, kept as noon UTC) and optional note; null clears it */
export async function scheduleFollowUp(
  profile: Profile,
  leadId: string,
  input: z.input<typeof followUpSchema>,
): Promise<CrmResult> {
  const parsed = followUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Pick a valid date." };
  if (!(await getCrmLead(profile.id, leadId))) return NOT_FOUND;
  const at = parsed.data.date ? new Date(`${parsed.data.date}T12:00:00Z`) : null;
  await setLeadFollowUp(profile.id, leadId, at, parsed.data.note || null);
  if (at) await addLeadActivity(profile.id, leadId, "follow_up_set", { userEntered: true, detail: { date: parsed.data.date } });
  return { ok: true, message: at ? "Follow-up set." : "Follow-up cleared." };
}

export async function finishFollowUp(profile: Profile, leadId: string): Promise<CrmResult> {
  const current = await getCrmLead(profile.id, leadId);
  if (!current) return NOT_FOUND;
  if (!current.lead.followUpAt) return { ok: false, message: "No follow-up to complete." };
  await completeLeadFollowUp(profile.id, leadId);
  await addLeadActivity(profile.id, leadId, "follow_up_done", { userEntered: true });
  return { ok: true, message: "Follow-up done." };
}

/** "I contacted them" / "They responded": what the user tells Scout, never verified */
export async function logInteraction(profile: Profile, leadId: string, kind: "contact" | "response"): Promise<CrmResult> {
  const current = await getCrmLead(profile.id, leadId);
  if (!current) return NOT_FOUND;
  await addLeadActivity(profile.id, leadId, kind === "contact" ? "contact_logged" : "response_logged", { userEntered: true });
  // Moves the pipeline forward, never back
  const target: LeadStatus = kind === "contact" ? "contacted" : "replied";
  const order = LEAD_STATUSES.indexOf.bind(LEAD_STATUSES);
  if (order(current.lead.status) < order(target)) await changeLeadStatus(profile, leadId, target);
  return { ok: true, message: kind === "contact" ? "Logged your contact." : "Logged their response." };
}

export async function removeLead(profile: Profile, leadId: string): Promise<CrmResult> {
  return (await deleteLead(profile.id, leadId)) ? { ok: true } : NOT_FOUND;
}
