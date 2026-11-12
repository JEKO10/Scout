import "server-only";

import { and, desc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";

import db from "@/db";
import {
  notificationDailyCountsTable,
  notificationDeliveriesTable,
  type NotificationDelivery,
  type NotificationSettings,
  notificationSettingsTable,
  notificationsTable,
  opportunitiesTable,
  type SlackConnection,
  slackConnectionsTable,
} from "@/db/schema";
import { NOTIFICATION_DEFAULTS } from "@/lib/notifications/rules";

type Channel = NotificationDelivery["channel"];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type NotificationPreferences = Omit<NotificationSettings, "profileId" | "createdAt" | "updatedAt">;

/** The user's preferences, or the defaults (Slack alerts off) when never saved. */
export async function getNotificationSettings(profileId: string): Promise<NotificationPreferences> {
  const t = notificationSettingsTable;
  const [row] = await db
    .select({
      slackEnabled: t.slackEnabled,
      minScore: t.minScore,
      maxPerDay: t.maxPerDay,
      quietHoursStart: t.quietHoursStart,
      quietHoursEnd: t.quietHoursEnd,
      timezone: t.timezone,
    })
    .from(t)
    .where(eq(t.profileId, profileId));
  return row ?? { ...NOTIFICATION_DEFAULTS };
}

export async function saveNotificationSettings(
  profileId: string,
  values: Partial<NotificationPreferences>,
): Promise<void> {
  await db
    .insert(notificationSettingsTable)
    .values({ profileId, ...values })
    .onConflictDoUpdate({ target: notificationSettingsTable.profileId, set: values });
}

// ---------------------------------------------------------------------------
// Slack connection
// ---------------------------------------------------------------------------

export async function getSlackConnection(profileId: string): Promise<SlackConnection | undefined> {
  const [row] = await db
    .select()
    .from(slackConnectionsTable)
    .where(eq(slackConnectionsTable.profileId, profileId));
  return row;
}

/**
 * Saves a (re)installation. Reconnecting the same workspace keeps the chosen
 * channel; a different workspace starts without one.
 */
export async function saveSlackConnection(
  profileId: string,
  install: {
    teamId: string;
    teamName: string;
    botUserId: string | null;
    scopes: string;
    encryptedBotToken: string;
  },
): Promise<void> {
  const sameTeam = sql`${slackConnectionsTable.teamId} = excluded."teamId"`;
  await db
    .insert(slackConnectionsTable)
    .values({ profileId, ...install })
    .onConflictDoUpdate({
      target: slackConnectionsTable.profileId,
      set: {
        ...install,
        channelId: sql`case when ${sameTeam} then ${slackConnectionsTable.channelId} end`,
        channelName: sql`case when ${sameTeam} then ${slackConnectionsTable.channelName} end`,
        status: "active",
        lastError: null,
      },
    });
}

export async function setSlackChannel(
  profileId: string,
  channel: { channelId: string; channelName: string },
): Promise<void> {
  await db
    .update(slackConnectionsTable)
    .set({ ...channel, status: "active", lastError: null })
    .where(eq(slackConnectionsTable.profileId, profileId));
}

export async function markSlackConnection(
  profileId: string,
  status: SlackConnection["status"],
  lastError: string | null,
): Promise<void> {
  await db
    .update(slackConnectionsTable)
    .set({ status, lastError })
    .where(eq(slackConnectionsTable.profileId, profileId));
}

export async function deleteSlackConnection(profileId: string): Promise<SlackConnection | undefined> {
  const [row] = await db
    .delete(slackConnectionsTable)
    .where(eq(slackConnectionsTable.profileId, profileId))
    .returning();
  return row;
}

/** Other Scout users connected to the same workspace share its bot token. */
export async function countOtherTeamConnections(teamId: string, profileId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(slackConnectionsTable)
    .where(and(eq(slackConnectionsTable.teamId, teamId), ne(slackConnectionsTable.profileId, profileId)));
  return row.value;
}

// ---------------------------------------------------------------------------
// Notifications and deliveries
// ---------------------------------------------------------------------------

/** A run's new opportunities worth an alert, freshest post first. */
export async function getAlertCandidates(
  profileId: string,
  scoutRunId: string,
  { minScore, postedAfter }: { minScore: number; postedAfter: Date },
) {
  return db
    .select({
      id: opportunitiesTable.id,
      score: opportunitiesTable.score,
      postedAt: opportunitiesTable.postedAt,
    })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.profileId, profileId),
        eq(opportunitiesTable.scoutRunId, scoutRunId),
        eq(opportunitiesTable.status, "new"),
        gte(opportunitiesTable.score, minScore),
        gte(opportunitiesTable.postedAt, postedAfter),
      ),
    )
    .orderBy(desc(opportunitiesTable.postedAt), desc(opportunitiesTable.score));
}

/** Creates the in-app notification; null when the opportunity already has one. */
export async function createNotification(
  profileId: string,
  opportunityId: string,
): Promise<string | null> {
  const [row] = await db
    .insert(notificationsTable)
    .values({ profileId, opportunityId })
    .onConflictDoNothing({ target: notificationsTable.opportunityId })
    .returning({ id: notificationsTable.id });
  return row?.id ?? null;
}

/** False when this notification already has a delivery on the channel. */
export async function createDelivery(values: {
  notificationId: string;
  profileId: string;
  channel: Channel;
  day: string;
  status: "pending" | "suppressed";
  reason?: string;
}): Promise<boolean> {
  const rows = await db
    .insert(notificationDeliveriesTable)
    .values(values)
    .onConflictDoNothing({
      target: [notificationDeliveriesTable.notificationId, notificationDeliveriesTable.channel],
    })
    .returning({ id: notificationDeliveriesTable.id });
  return rows.length > 0;
}

/**
 * Takes one of today's alert slots, or returns false when the limit is
 * reached. A single conditional upsert, so parallel workers can't overshoot.
 */
export async function reserveDailySlot(
  profileId: string,
  channel: Channel,
  day: string,
  max: number,
): Promise<boolean> {
  if (max < 1) return false;
  const t = notificationDailyCountsTable;
  const result = await db.execute<{ count: number }>(sql`
    insert into ${t} ("profileId", "channel", "day", "count")
    values (${profileId}, ${channel}, ${day}, 1)
    on conflict ("profileId", "channel", "day")
    do update set "count" = ${t}."count" + 1
    where ${t}."count" < ${max}
    returning "count"
  `);
  return result.rows.length > 0;
}

/** Gives a slot back: the alert was never delivered. */
export async function releaseDailySlot(profileId: string, channel: Channel, day: string): Promise<void> {
  const t = notificationDailyCountsTable;
  await db
    .update(t)
    .set({ count: sql`greatest(${t.count} - 1, 0)` })
    .where(and(eq(t.profileId, profileId), eq(t.channel, channel), eq(t.day, day)));
}

export async function getDailyCount(profileId: string, channel: Channel, day: string): Promise<number> {
  const t = notificationDailyCountsTable;
  const [row] = await db
    .select({ count: t.count })
    .from(t)
    .where(and(eq(t.profileId, profileId), eq(t.channel, channel), eq(t.day, day)));
  return row?.count ?? 0;
}

/** Deliveries whose worker died mid-send: back to pending, or failed after the last attempt. */
export async function reapExpiredDeliveries(maxAttempts: number): Promise<NotificationDelivery[]> {
  const t = notificationDeliveriesTable;
  return db
    .update(t)
    .set({
      status: sql`case when ${t.attempts} >= ${maxAttempts} then 'failed' else 'pending' end::notification_delivery_status`,
      reason: sql`case when ${t.attempts} >= ${maxAttempts} then 'worker_stopped' end`,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(and(eq(t.status, "sending"), lt(t.lockedUntil, sql`now()`)))
    .returning();
}

/** Claims the next due delivery for this worker (SKIP LOCKED: parallel workers take different ones). */
export async function claimNextDelivery(
  workerId: string,
  lockSeconds: number,
): Promise<NotificationDelivery | null> {
  const t = notificationDeliveriesTable;
  const result = await db.execute<{ id: string }>(sql`
    update ${t}
    set "status" = 'sending',
        "lockedBy" = ${workerId},
        "lockedUntil" = now() + make_interval(secs => ${lockSeconds}),
        "attempts" = "attempts" + 1,
        "updatedAt" = now()
    where "id" = (
      select "id" from ${t}
      where "status" = 'pending' and "runAfter" <= now()
      order by "runAfter"
      limit 1
      for update skip locked
    )
    returning "id"
  `);
  const id = result.rows[0]?.id;
  if (!id) return null;
  const [delivery] = await db.select().from(t).where(eq(t.id, id));
  return delivery;
}

type DeliveryFinish =
  | { status: "sent"; providerMessageId: string }
  | { status: "failed" | "suppressed"; reason: string; error?: string };

/** Closes a delivery this worker holds. False when its claim was lost. */
export async function finishDelivery(
  delivery: NotificationDelivery,
  workerId: string,
  finish: DeliveryFinish,
): Promise<boolean> {
  const t = notificationDeliveriesTable;
  const rows = await db
    .update(t)
    .set({
      status: finish.status,
      reason: finish.status === "sent" ? null : finish.reason,
      error: finish.status === "sent" ? null : (finish.error?.slice(0, 500) ?? null),
      providerMessageId: finish.status === "sent" ? finish.providerMessageId : null,
      sentAt: finish.status === "sent" ? sql`now()` : null,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(and(eq(t.id, delivery.id), eq(t.lockedBy, workerId)))
    .returning({ id: t.id });
  return rows.length > 0;
}

export async function retryDeliveryLater(
  delivery: NotificationDelivery,
  workerId: string,
  { error, delaySeconds }: { error: string; delaySeconds: number },
): Promise<boolean> {
  const t = notificationDeliveriesTable;
  const rows = await db
    .update(t)
    .set({
      status: "pending",
      error: error.slice(0, 500),
      runAfter: sql`now() + make_interval(secs => ${delaySeconds})`,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(and(eq(t.id, delivery.id), eq(t.lockedBy, workerId)))
    .returning({ id: t.id });
  return rows.length > 0;
}

/** The notification and its opportunity, for building the message. */
export async function getNotificationWithOpportunity(notificationId: string) {
  const [row] = await db
    .select({ notification: notificationsTable, opportunity: opportunitiesTable })
    .from(notificationsTable)
    .innerJoin(opportunitiesTable, eq(opportunitiesTable.id, notificationsTable.opportunityId))
    .where(eq(notificationsTable.id, notificationId));
  return row;
}

export async function getLastDelivery(
  profileId: string,
  channel: Channel,
): Promise<NotificationDelivery | undefined> {
  const t = notificationDeliveriesTable;
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.profileId, profileId), eq(t.channel, channel)))
    .orderBy(desc(t.createdAt))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// In-app history (the bell)
// ---------------------------------------------------------------------------

export async function countUnreadNotifications(profileId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.profileId, profileId), isNull(notificationsTable.readAt)));
  return row.value;
}

export async function getRecentNotifications(profileId: string, limit = 10) {
  return db
    .select({
      id: notificationsTable.id,
      opportunityId: notificationsTable.opportunityId,
      readAt: notificationsTable.readAt,
      createdAt: notificationsTable.createdAt,
      authorHandle: opportunitiesTable.authorHandle,
      content: opportunitiesTable.content,
      score: opportunitiesTable.score,
    })
    .from(notificationsTable)
    .innerJoin(opportunitiesTable, eq(opportunitiesTable.id, notificationsTable.opportunityId))
    .where(eq(notificationsTable.profileId, profileId))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(limit);
}

/** Only the owner's notifications; returns how many were marked. */
export async function markNotificationsRead(profileId: string, notificationId?: string): Promise<number> {
  const rows = await db
    .update(notificationsTable)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notificationsTable.profileId, profileId),
        isNull(notificationsTable.readAt),
        notificationId ? eq(notificationsTable.id, notificationId) : undefined,
      ),
    )
    .returning({ id: notificationsTable.id });
  return rows.length;
}
