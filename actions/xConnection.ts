"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { requireProfile } from "@/lib/auth/session";
import { disconnectX } from "@/services/x/oauthConnection";

const disconnectSchema = z.object({ deleteHistory: z.boolean() });

/** Revokes Scout's X tokens and removes the connection; optionally the private metric history too */
export async function disconnectXAction(input: { deleteHistory: boolean }): Promise<{ ok: boolean; message: string }> {
  const { profile } = await requireProfile();
  const parsed = disconnectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const { deletedReadings } = await disconnectX(profile.id, parsed.data);
  refresh();
  return {
    ok: true,
    message: parsed.data.deleteHistory
      ? `X disconnected. ${deletedReadings} stored metric readings deleted.`
      : "X disconnected. Metrics Scout already stored stay until you delete them.",
  };
}
