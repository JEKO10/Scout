"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { getTrend, setTrendSaved } from "@/db/queries/trends";
import { requireProfile } from "@/lib/auth/session";
import { track } from "@/services/analytics/track";
import { generateTrendInsight } from "@/services/trends/insight";

/** A conversation opened from a trend: recorded as opened, nothing more */
export async function trendConversationOpenedAction(trendId: string): Promise<void> {
  if (!z.uuid().safeParse(trendId).success) return;
  const { profile } = await requireProfile();
  if (await getTrend(profile.id, trendId)) await track("trend_conversation_opened", { profileId: profile.id });
}

/** Save / unsave: saved trends stay through future scans */
export async function setTrendSavedAction(trendId: string, saved: boolean): Promise<{ ok: boolean }> {
  if (!z.uuid().safeParse(trendId).success) return { ok: false };
  const { profile } = await requireProfile();
  const ok = await setTrendSaved(profile.id, trendId, Boolean(saved));
  if (ok && saved) await track("trend_saved", { profileId: profile.id });
  if (ok) refresh();
  return { ok };
}

/** "Explain this trend": cached; the AI is called only when the evidence changed */
export async function generateTrendInsightAction(trendId: string): Promise<{ ok: boolean; message?: string }> {
  if (!z.uuid().safeParse(trendId).success) return { ok: false, message: "Trend not found." };
  const { profile } = await requireProfile();
  try {
    const result = await generateTrendInsight(profile, trendId);
    if (!result.ok) return result;
    refresh();
    return { ok: true };
  } catch (error) {
    console.error("Trend insight failed", error instanceof Error ? error.message : error);
    return { ok: false, message: "Couldn't write an insight right now. Try again later." };
  }
}
