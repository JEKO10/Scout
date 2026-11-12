import "server-only";

import {
  createDelivery,
  createNotification,
  getAlertCandidates,
  getNotificationSettings,
  getSlackConnection,
  releaseDailySlot,
  reserveDailySlot,
} from "@/db/queries/notifications";
import { isQuietHours, localDay, NOTIFICATION_LIMITS } from "@/lib/notifications/rules";

export type QueueResult = {
  /** In-app notifications created */
  notified: number;
  /** Slack deliveries queued for the delivery worker */
  slackQueued: number;
  /** Slack alerts not sent on purpose, by reason */
  slackSuppressed: Record<string, number>;
};

/**
 * After an automatic scan: turns the run's strong, fresh opportunities into
 * notifications and queues their Slack deliveries. Only reads what scoring
 * already stored: no OpenAI or X calls. Safe to call twice for the same run;
 * the unique constraints make every step idempotent.
 */
export async function queueRunNotifications(
  profileId: string,
  scoutRunId: string,
  now = new Date(),
): Promise<QueueResult> {
  const result: QueueResult = { notified: 0, slackQueued: 0, slackSuppressed: {} };
  const settings = await getNotificationSettings(profileId);
  const candidates = await getAlertCandidates(profileId, scoutRunId, {
    minScore: settings.minScore,
    postedAfter: new Date(now.getTime() - NOTIFICATION_LIMITS.maxPostAgeHours * 3600_000),
  });
  if (candidates.length === 0) return result;

  const connection = settings.slackEnabled ? await getSlackConnection(profileId) : undefined;
  const slackReady = connection?.status === "active" && Boolean(connection.channelId);
  const day = localDay(now, settings.timezone);
  const quiet = isQuietHours(now, settings);
  const suppress = async (notificationId: string, reason: string) => {
    if (await createDelivery({ notificationId, profileId, channel: "slack", day, status: "suppressed", reason })) {
      result.slackSuppressed[reason] = (result.slackSuppressed[reason] ?? 0) + 1;
    }
  };

  // Freshest first, so when the daily limit runs out the newest conversations got the slots
  for (const candidate of candidates) {
    const notificationId = await createNotification(profileId, candidate.id);
    if (!notificationId) continue; // Already notified about this opportunity
    result.notified++;
    if (!slackReady) continue;

    if (quiet) {
      await suppress(notificationId, "quiet_hours");
      continue;
    }
    if (!(await reserveDailySlot(profileId, "slack", day, settings.maxPerDay))) {
      await suppress(notificationId, "daily_limit");
      continue;
    }
    const queued = await createDelivery({ notificationId, profileId, channel: "slack", day, status: "pending" });
    if (queued) result.slackQueued++;
    else await releaseDailySlot(profileId, "slack", day);
  }
  return result;
}
