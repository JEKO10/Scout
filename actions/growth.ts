"use server";

import { refresh } from "next/cache";

import { requireProfile } from "@/lib/auth/session";
import { refreshGrowthData } from "@/services/growth/collect";

/** The user asks Scout to re-read their newest posts and follower count from X */
export async function refreshGrowthAction(): Promise<{ ok: boolean; message: string }> {
  const { profile } = await requireProfile();
  const result = await refreshGrowthData(profile);
  if (result.ok) refresh();
  return result;
}
