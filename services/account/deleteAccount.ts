import "server-only";

import {
  deleteProfileData,
  deletionsToResume,
  getDeletionByUserId,
  profileExists,
  purgeCompletedDeletions,
  startDeletion,
  stopProcessing,
  updateDeletion,
} from "@/db/queries/accountDeletions";
import { getSubscriptionsForProfile } from "@/db/queries/billing";
import { cancelActivePublications, countPublishing } from "@/db/queries/publications";
import type { AccountDeletion, Profile } from "@/db/schema";
import { DELETION_RECORD_DAYS } from "@/lib/compliance/retention";
import { disconnectSlack } from "@/services/notifications/slackConnection";
import { revokeAndDeleteXConnection } from "@/services/x/oauthConnection";

// Day 40.1 account deletion, in an order that is safe to stop at any step
// and finish later:
// 1. checks that change nothing (a post being sent right now, an active paid
//    subscription);
// 2. the deletion record (outlives the profile, blocks re-creating it);
// 3. stop everything automatic (scans, automations, preparation, schedules);
// 4. revoke Scout's X access at X (strict: X must confirm), disconnect Slack;
// 5. delete the profile, and with it everything it owns (foreign keys cascade);
// 6. delete the sign-in at Neon Auth (needs the user's session, so it runs
//    in the same request).
// It reports "completed" only when every step succeeded.

export type DeleteAccountResult =
  | { ok: true; status: "completed" }
  | { ok: false; status: "blocked" | "needs_attention"; message: string; dataDeleted: boolean };

export type DeleteAccountDeps = {
  /** Deletes the Neon Auth user of the current session; true only when Neon Auth confirms */
  deleteLogin: () => Promise<boolean>;
};

const ACTIVE_SUBSCRIPTION = ["active", "trialing", "past_due", "paused"];

/** Scout data stays out of reach while this runs: the guard in requireProfile reads it */
export async function deletionFor(userId: string): Promise<AccountDeletion | undefined> {
  return getDeletionByUserId(userId);
}

export async function deleteAccount(
  profile: Pick<Profile, "id" | "userId">,
  deps: DeleteAccountDeps,
  now = new Date(),
): Promise<DeleteAccountResult> {
  const existing = await getDeletionByUserId(profile.userId);
  if (existing?.status === "completed") return { ok: true, status: "completed" };

  const dataAlreadyDeleted = Boolean(existing?.steps.dataDeleted);
  if (!dataAlreadyDeleted) {
    // 1. Checks that change nothing
    if ((await countPublishing(profile.id)) > 0) {
      return { ok: false, status: "blocked", dataDeleted: false, message: "A post is being published to X right now. Try again in a minute." };
    }
    const subscriptions = await getSubscriptionsForProfile(profile.id);
    const paying = subscriptions.find((s) => ACTIVE_SUBSCRIPTION.includes(s.status) && s.scheduledChange?.action !== "cancel");
    if (paying) {
      return {
        ok: false,
        status: "blocked",
        dataDeleted: false,
        message: "Cancel your subscription in Settings first (Plan & billing). You can delete your account right after.",
      };
    }
  }

  // 2. The record
  const record = existing ?? (await startDeletion(profile.userId, profile.id));
  let steps = { ...record.steps };
  const save = (patch: Parameters<typeof updateDeletion>[1]) => updateDeletion(record.id, { steps, ...patch });
  const stop = async (message: string): Promise<DeleteAccountResult> => {
    await save({ status: "needs_attention", error: message });
    return { ok: false, status: "needs_attention", message, dataDeleted: Boolean(steps.dataDeleted) };
  };

  if (!steps.dataDeleted) {
    // 3. Nothing automatic runs any more; nothing scheduled is published
    await stopProcessing(profile.id, now);
    await cancelActivePublications(profile.id, "Account deletion requested.");
    steps = { ...steps, processingStopped: true };
    await save({ status: "in_progress", error: null });

    // 4. Third-party access
    if (!steps.xRevoked) {
      const x = await revokeAndDeleteXConnection(profile.id);
      if (x === "failed") return stop("X didn't confirm that Scout's access was revoked. Nothing was deleted yet. Try again in a few minutes.");
      steps = { ...steps, xRevoked: true };
      await save({});
    }
    if (!steps.slackRevoked) {
      // Slack's bot token is shared by everyone in the same workspace: Slack
      // revokes it only when no other Scout user uses it (best effort at Slack;
      // Scout deletes its copy either way)
      await disconnectSlack(profile.id);
      steps = { ...steps, slackRevoked: true };
      await save({});
    }

    // 5. The data
    try {
      if (await profileExists(profile.id)) await deleteProfileData(profile.id);
      steps = { ...steps, dataDeleted: true };
      await save({});
    } catch (error) {
      console.error("Account deletion: deleting data failed", error instanceof Error ? error.message : error);
      return stop("Deleting your data didn't finish. Scout will retry automatically; nothing will be processed for your account meanwhile.");
    }
  }

  // 6. The sign-in
  if (!steps.loginDeleted) {
    let loginDeleted = false;
    try {
      loginDeleted = await deps.deleteLogin();
    } catch (error) {
      console.error("Account deletion: deleting the login failed", error instanceof Error ? error.message : error);
    }
    if (!loginDeleted) {
      return stop("Your Scout data is deleted, but your sign-in couldn't be removed automatically. Contact support to finish; you can't use this account meanwhile.");
    }
    steps = { ...steps, loginDeleted: true };
  }
  await save({ status: "completed", error: null, completedAt: now });
  return { ok: true, status: "completed" };
}

/**
 * Scheduler step: finishes deletions whose data step didn't complete (the
 * X access was already revoked, so no user action is needed), and drops
 * finished records after a while. The sign-in step needs the user's session
 * and is never done here.
 */
export async function resumeAccountDeletions(now = new Date()) {
  let resumed = 0;
  for (const record of await deletionsToResume(now, 5 * 60_000)) {
    try {
      if (await profileExists(record.profileId)) await deleteProfileData(record.profileId);
      const steps = { ...record.steps, dataDeleted: true };
      await updateDeletion(record.id, {
        steps,
        status: steps.loginDeleted ? "completed" : "needs_attention",
        error: steps.loginDeleted ? null : "Your Scout data is deleted. Removing the sign-in still needs a step.",
        ...(steps.loginDeleted ? { completedAt: now } : {}),
      });
      resumed++;
    } catch (error) {
      console.error("Resuming an account deletion failed", record.id, error instanceof Error ? error.message : error);
    }
  }
  const purged = await purgeCompletedDeletions(now, DELETION_RECORD_DAYS);
  return { resumed, purged };
}
