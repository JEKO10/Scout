"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import {
  getSlackConnection,
  markNotificationsRead,
  saveNotificationSettings,
} from "@/db/queries/notifications";
import { requireProfile } from "@/lib/auth/session";
import { isValidTimezone, NOTIFICATION_LIMITS } from "@/lib/notifications/rules";
import {
  chooseSlackChannel,
  disconnectSlack,
  listSlackChannels,
  sendSlackTestMessage,
} from "@/services/notifications/slackConnection";

type ActionResult = { ok: boolean; message: string };

const hour = z.number().int().min(0).max(23).nullable();

const settingsSchema = z
  .object({
    slackEnabled: z.boolean(),
    minScore: z.number().int().min(NOTIFICATION_LIMITS.minScore.min).max(NOTIFICATION_LIMITS.minScore.max),
    maxPerDay: z.number().int().min(NOTIFICATION_LIMITS.maxPerDay.min).max(NOTIFICATION_LIMITS.maxPerDay.max),
    quietHoursStart: hour,
    quietHoursEnd: hour,
    timezone: z.string().max(64).refine(isValidTimezone, "Unknown timezone"),
  })
  .refine((value) => (value.quietHoursStart === null) === (value.quietHoursEnd === null), {
    message: "Set both quiet hours or neither",
  });

export async function saveNotificationSettingsAction(
  settings: z.input<typeof settingsSchema>,
): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) return { ok: false, message: "Check the notification settings." };

  if (parsed.data.slackEnabled) {
    // Alerts only go to a channel Scout has verified it can post to
    const connection = await getSlackConnection(profile.id);
    if (!connection?.channelId || connection.status !== "active") {
      return { ok: false, message: "Connect Slack and choose a channel first." };
    }
  }
  await saveNotificationSettings(profile.id, parsed.data);
  refresh();
  return { ok: true, message: "Notification settings saved." };
}

export async function listSlackChannelsAction(): Promise<
  { ok: true; channels: { id: string; name: string }[] } | { ok: false; message: string }
> {
  const { profile } = await requireProfile();
  const result = await listSlackChannels(profile.id);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, channels: result.value.map(({ id, name }) => ({ id, name })) };
}

const channelSchema = z.string().regex(/^[CG][A-Z0-9]{4,}$/);

export async function chooseSlackChannelAction(channelId: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = channelSchema.safeParse(channelId);
  if (!parsed.success) return { ok: false, message: "Choose a channel." };
  const result = await chooseSlackChannel(profile.id, parsed.data);
  refresh();
  return result.ok
    ? { ok: true, message: `Scout joined #${result.value.name} and will post alerts there.` }
    : { ok: false, message: result.message };
}

/** Sends one labeled test message; "ok" only after Slack confirmed it. */
export async function sendTestNotificationAction(): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const result = await sendSlackTestMessage(profile.id);
  if (!result.ok) {
    // A failure may have flagged the connection (reconnect / pick another channel)
    refresh();
    return { ok: false, message: result.message };
  }
  return { ok: true, message: `Test sent to #${result.value.channelName}. Check Slack.` };
}

export async function disconnectSlackAction(): Promise<ActionResult> {
  const { profile } = await requireProfile();
  await disconnectSlack(profile.id);
  refresh();
  return { ok: true, message: "Slack disconnected." };
}

export async function markNotificationsReadAction(notificationId?: string): Promise<{ ok: boolean }> {
  const { profile } = await requireProfile();
  if (notificationId !== undefined && !z.uuid().safeParse(notificationId).success) return { ok: false };
  await markNotificationsRead(profile.id, notificationId);
  return { ok: true };
}
