import "server-only";

import { randomUUID } from "node:crypto";

import {
  claimNextDelivery,
  finishDelivery,
  getNotificationSettings,
  getNotificationWithOpportunity,
  getSlackConnection,
  markSlackConnection,
  reapExpiredDeliveries,
  releaseDailySlot,
  retryDeliveryLater,
} from "@/db/queries/notifications";
import type { NotificationDelivery } from "@/db/schema";
import { appUrl } from "@/lib/appUrl";
import { decryptToken } from "@/lib/crypto/tokens";
import { opportunitySlackMessage } from "@/lib/notifications/slackMessage";
import { postMessage, SlackApiError } from "@/lib/slack/client";

/**
 * Delivery worker (Day 19). Runs inside the scheduler tick, after the scans:
 * claims queued deliveries and sends them, all awaited within the request,
 * so nothing is fire-and-forget in a serverless function. A delivery that
 * can't go out now stays queued in Postgres for the next tick.
 */
export const DELIVERY = {
  maxPerTick: 25,
  timeBudgetMs: 30_000,
  /** A claim older than this means the worker died; the delivery is retried */
  lockSeconds: 60,
  maxAttempts: 4,
  /** Retry delays after a Slack or network error */
  backoffSeconds: [60, 300, 900],
  /** An alert this late is noise, not news */
  maxAgeHours: 6,
  /** Slack allows about one message per second per channel */
  minChannelGapMs: 1100,
};

export type DeliveryOutcome = {
  deliveryId: string;
  profileId: string;
  status: "sent" | "retry" | "failed" | "suppressed";
  reason?: string;
};

export type DeliveryTickResult = { reaped: number; outcomes: DeliveryOutcome[] };

export async function deliverPendingNotifications({
  workerId = randomUUID(),
  maxDeliveries = DELIVERY.maxPerTick,
  timeBudgetMs = DELIVERY.timeBudgetMs,
}: { workerId?: string; maxDeliveries?: number; timeBudgetMs?: number } = {}): Promise<DeliveryTickResult> {
  const started = Date.now();
  const reaped = await reapExpiredDeliveries(DELIVERY.maxAttempts);
  for (const delivery of reaped) {
    if (delivery.status === "failed") await releaseDailySlot(delivery.profileId, delivery.channel, delivery.day);
  }

  const lastPostByChannel = new Map<string, number>();
  const outcomes: DeliveryOutcome[] = [];
  while (outcomes.length < maxDeliveries && Date.now() - started < timeBudgetMs) {
    const delivery = await claimNextDelivery(workerId, DELIVERY.lockSeconds);
    if (!delivery) break;
    outcomes.push(await deliverOne(delivery, workerId, lastPostByChannel));
  }
  return { reaped: reaped.length, outcomes };
}

async function deliverOne(
  delivery: NotificationDelivery,
  workerId: string,
  lastPostByChannel: Map<string, number>,
): Promise<DeliveryOutcome> {
  const outcome = (status: DeliveryOutcome["status"], reason?: string): DeliveryOutcome => ({
    deliveryId: delivery.id,
    profileId: delivery.profileId,
    status,
    reason,
  });
  // Not sent: the slot goes back to today's limit
  const close = async (status: "failed" | "suppressed", reason: string, error?: string) => {
    await finishDelivery(delivery, workerId, { status, reason, error });
    await releaseDailySlot(delivery.profileId, delivery.channel, delivery.day);
    return outcome(status, reason);
  };

  if (Date.now() - delivery.createdAt.getTime() > DELIVERY.maxAgeHours * 3600_000) {
    return close("failed", "stale");
  }

  const [settings, connection, item] = await Promise.all([
    getNotificationSettings(delivery.profileId),
    getSlackConnection(delivery.profileId),
    getNotificationWithOpportunity(delivery.notificationId),
  ]);
  // Every check uses this delivery's own profile: one user's settings or
  // workspace can never be used for another user's alert
  if (!item || item.notification.profileId !== delivery.profileId) return close("failed", "not_found");
  if (!settings.slackEnabled) return close("suppressed", "disabled");
  if (!connection) return close("suppressed", "not_connected");
  if (connection.status !== "active" || !connection.channelId) {
    return close("suppressed", connection.status === "active" ? "no_channel" : connection.status);
  }
  if (item.opportunity.status !== "new" && item.opportunity.status !== "saved") {
    return close("suppressed", "already_handled");
  }

  let token: string;
  try {
    token = decryptToken(connection.encryptedBotToken);
  } catch {
    await markSlackConnection(delivery.profileId, "needs_reconnect", "token_unreadable");
    return close("failed", "token_unreadable");
  }

  const channelKey = `${connection.teamId}:${connection.channelId}`;
  const wait = (lastPostByChannel.get(channelKey) ?? 0) + DELIVERY.minChannelGapMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  try {
    const message = opportunitySlackMessage(item.opportunity, {
      openInScout: `${appUrl()}/opportunities/${item.opportunity.id}`,
    });
    const { ts } = await postMessage(token, { channel: connection.channelId, ...message });
    lastPostByChannel.set(channelKey, Date.now());
    await finishDelivery(delivery, workerId, { status: "sent", providerMessageId: ts });
    return outcome("sent");
  } catch (caught) {
    lastPostByChannel.set(channelKey, Date.now());
    const error =
      caught instanceof SlackApiError
        ? caught
        : new SlackApiError(caught instanceof Error ? caught.message : "unknown_error", "transient");

    switch (error.kind) {
      case "auth":
        await markSlackConnection(delivery.profileId, "needs_reconnect", error.code);
        return close("failed", error.code);
      case "channel":
        await markSlackConnection(delivery.profileId, "channel_unavailable", error.code);
        return close("failed", error.code);
      case "permanent":
        return close("failed", error.code);
      case "rate_limited":
      case "transient": {
        if (delivery.attempts >= DELIVERY.maxAttempts) return close("failed", error.code);
        const backoff = DELIVERY.backoffSeconds[Math.min(delivery.attempts, DELIVERY.backoffSeconds.length) - 1];
        // Rate limited: exactly as long as Slack's Retry-After asks
        const delaySeconds = error.kind === "rate_limited" ? (error.retryAfterSeconds ?? 30) : backoff;
        await retryDeliveryLater(delivery, workerId, { error: error.code, delaySeconds });
        return outcome("retry", error.code);
      }
    }
  }
}
