"use server";

import { getDeletionByUserId } from "@/db/queries/accountDeletions";
import { getProfileByUserId } from "@/db/queries/profiles";
import { auth } from "@/lib/auth/server";
import { requireUser } from "@/lib/auth/session";
import { deleteAccount, type DeleteAccountResult } from "@/services/account/deleteAccount";

/**
 * Neon Auth deletes the signed-in user (Better Auth's delete-user). True
 * only when Neon Auth says the user was deleted: if the project requires an
 * email confirmation or doesn't allow self-deletion, the login stays and the
 * deletion is reported as not finished.
 */
async function deleteNeonAuthUser(): Promise<boolean> {
  const result = (await auth.deleteUser({})) as { data?: { success?: boolean; message?: string } | null; error?: unknown };
  if (result.error || !result.data) return false;
  return result.data.success === true && /deleted/i.test(result.data.message ?? "");
}

/**
 * "Delete my account" (Settings), also used to retry a deletion that
 * stopped half way. The user types DELETE to confirm.
 */
export async function deleteAccountAction(confirmation: string): Promise<DeleteAccountResult | { ok: false; status: "invalid"; message: string; dataDeleted: false }> {
  const user = await requireUser();
  if (confirmation !== "DELETE") return { ok: false, status: "invalid", message: "Type DELETE to confirm.", dataDeleted: false };
  const profile = await getProfileByUserId(user.id);
  // The data may already be gone (a retry of the sign-in step)
  const target = profile ?? (await getDeletionByUserId(user.id).then((record) => (record ? { id: record.profileId, userId: user.id } : null)));
  if (!target) return { ok: false, status: "invalid", message: "There's no account to delete.", dataDeleted: false };
  try {
    const result = await deleteAccount({ id: target.id, userId: user.id }, { deleteLogin: deleteNeonAuthUser });
    // The sign-in is gone: end the session cookie too (best effort; the deletion record blocks access either way)
    if (result.ok) await auth.signOut().catch(() => undefined);
    return result;
  } catch (error) {
    console.error("Account deletion failed", error instanceof Error ? error.message : error);
    return { ok: false, status: "needs_attention", message: "Something went wrong. Nothing more was deleted; try again.", dataDeleted: false };
  }
}
