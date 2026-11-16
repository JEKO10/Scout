"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { ensureLeadOpportunity, getLead, setLeadSaved } from "@/db/queries/leads";
import { requireProfile } from "@/lib/auth/session";
import { track } from "@/services/analytics/track";
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

export async function setLeadSavedAction(id: string, saved: boolean): Promise<{ ok: boolean }> {
  if (!idSchema.safeParse(id).success) return { ok: false };
  const { profile } = await requireProfile();
  const ok = await setLeadSaved(profile.id, id, Boolean(saved));
  if (ok && saved) await track("lead_saved", { profileId: profile.id });
  if (ok) refresh();
  return { ok };
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
  await track("lead_reply_started", { profileId: profile.id });
  return { ok: true, href: `/opportunities/${opportunityId}` };
}

/** "Open on X": recorded as opened, never as contacted */
export async function leadOpenedAction(id: string): Promise<void> {
  if (!idSchema.safeParse(id).success) return;
  const { profile } = await requireProfile();
  if (await getLead(profile.id, id)) await track("lead_opened_on_x", { profileId: profile.id });
}
