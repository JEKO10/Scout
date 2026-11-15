import "server-only";

import { and, desc, eq, gte, inArray, lte, notInArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import db from "@/db";
import {
  type BillingSubscription,
  billingSubscriptionsTable,
  paddleWebhookEventsTable,
  profilesTable,
  slackConnectionsTable,
} from "@/db/schema";
import type { PlanId } from "@/lib/billing/plans";

export async function hasPaddleEvent(eventId: string): Promise<boolean> {
  const row = await db.query.paddleWebhookEventsTable.findFirst({ where: { eventId }, columns: { eventId: true } });
  return Boolean(row);
}

type EventValues = typeof paddleWebhookEventsTable.$inferInsert;

export async function recordPaddleEvent(values: EventValues): Promise<void> {
  // A concurrent retry of the same event may have recorded it first
  await db.insert(paddleWebhookEventsTable).values(values).onConflictDoNothing();
}

export async function getSubscriptionByPaddleId(paddleSubscriptionId: string): Promise<BillingSubscription | undefined> {
  return db.query.billingSubscriptionsTable.findFirst({ where: { paddleSubscriptionId } });
}

export async function getSubscriptionsForProfile(profileId: string): Promise<BillingSubscription[]> {
  return db.query.billingSubscriptionsTable.findMany({ where: { profileId } });
}

/** A subscription granting access created since a moment: the checkout page's confirmation */
export async function findGrantingSubscriptionSince(profileId: string, since: Date): Promise<BillingSubscription | undefined> {
  const [row] = await db
    .select()
    .from(billingSubscriptionsTable)
    .where(
      and(
        eq(billingSubscriptionsTable.profileId, profileId),
        inArray(billingSubscriptionsTable.status, ["active", "trialing", "past_due"]),
        gte(billingSubscriptionsTable.createdAt, since),
      ),
    )
    .limit(1);
  return row;
}

type SubscriptionValues = Omit<typeof billingSubscriptionsTable.$inferInsert, "id" | "createdAt" | "updatedAt">;

/**
 * One atomic write (a Neon batch runs as a single transaction): the
 * subscription's new state, the user's plan when it changes, and the event
 * marked as handled. If any part fails, none of it is kept and Paddle retries.
 * An older state never replaces a newer one, even if two arrive at once.
 */
export async function saveSubscriptionState({
  subscription,
  profilePlan,
  event,
}: {
  subscription: SubscriptionValues;
  profilePlan: { profileId: string; plan: PlanId } | null;
  event: EventValues | null;
}): Promise<void> {
  // The owner is fixed at creation; later states only update the rest
  const changes: Partial<SubscriptionValues> = { ...subscription };
  delete changes.profileId;
  delete changes.paddleSubscriptionId;
  const queries: [BatchItem<"pg">, ...BatchItem<"pg">[]] = [
    db
      .insert(billingSubscriptionsTable)
      .values(subscription)
      .onConflictDoUpdate({
        target: billingSubscriptionsTable.paddleSubscriptionId,
        set: changes,
        setWhere: lte(billingSubscriptionsTable.lastEventAt, subscription.lastEventAt),
      }),
  ];
  if (profilePlan) {
    queries.push(
      db
        .update(profilesTable)
        .set({ plan: profilePlan.plan })
        // Internal accounts are never changed by billing, even in a race
        .where(and(eq(profilesTable.id, profilePlan.profileId), inArray(profilesTable.plan, ["free", "starter", "pro"]))),
    );
  }
  if (event) queries.push(db.insert(paddleWebhookEventsTable).values(event).onConflictDoNothing());
  await db.batch(queries);
}

/** Where billing alerts go: the Slack channels connected by internal accounts */
export async function getInternalSlackTargets(): Promise<{ encryptedBotToken: string; channelId: string }[]> {
  const rows = await db
    .select({ encryptedBotToken: slackConnectionsTable.encryptedBotToken, channelId: slackConnectionsTable.channelId })
    .from(slackConnectionsTable)
    .innerJoin(profilesTable, eq(profilesTable.id, slackConnectionsTable.profileId))
    .where(and(eq(profilesTable.plan, "internal"), eq(slackConnectionsTable.status, "active")));
  return rows.filter((row): row is { encryptedBotToken: string; channelId: string } => Boolean(row.channelId));
}

/** Recent events that needed attention, for the internal dashboard */
export async function getBillingAlerts(limit = 20) {
  return db
    .select()
    .from(paddleWebhookEventsTable)
    .where(notInArray(paddleWebhookEventsTable.outcome, ["applied", "ignored", "stale", "duplicate"]))
    .orderBy(desc(paddleWebhookEventsTable.createdAt))
    .limit(limit);
}
