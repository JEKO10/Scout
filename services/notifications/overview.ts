import "server-only";

import {
  getDailyCount,
  getLastDelivery,
  getNotificationSettings,
  getSlackConnection,
} from "@/db/queries/notifications";
import { localDay } from "@/lib/notifications/rules";
import { isSlackConfigured } from "@/lib/slack/oauth";

/** Everything the notification settings show. Contains no token. */
export async function getNotificationOverview(profileId: string) {
  const [settings, connection, lastDelivery] = await Promise.all([
    getNotificationSettings(profileId),
    getSlackConnection(profileId),
    getLastDelivery(profileId, "slack"),
  ]);
  const sentToday = await getDailyCount(profileId, "slack", localDay(new Date(), settings.timezone));

  return {
    slackConfigured: isSlackConfigured(),
    connection: connection ? {
      teamName: connection.teamName,
      channelName: connection.channelName,
      status: connection.status,
    } : null,
    settings,
    sentToday,
    lastDelivery: lastDelivery ? {
      status: lastDelivery.status,
      reason: lastDelivery.reason,
      at: lastDelivery.sentAt ?? lastDelivery.updatedAt,
    } : null,
  };
}
