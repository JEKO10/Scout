import "server-only";

import { eq } from "drizzle-orm";

import db from "@/db";
import {
  type BillingSubscription,
  billingSubscriptionsTable,
  paddleWebhookEventsTable,
  profilesTable,
} from "@/db/schema";
import type { PlanId } from "@/lib/billing/plans";

export async function hasPaddleEvent(eventId: string): Promise<boolean> {
  const row = await db.query.paddleWebhookEventsTable.findFirst({ where: { eventId }, columns: { eventId: true } });
  return Boolean(row);
}

export async function recordPaddleEvent(values: typeof paddleWebhookEventsTable.$inferInsert): Promise<void> {
  // A concurrent retry of the same event may have recorded it first
  await db.insert(paddleWebhookEventsTable).values(values).onConflictDoNothing();
}

export async function getSubscriptionByPaddleId(paddleSubscriptionId: string): Promise<BillingSubscription | undefined> {
  return db.query.billingSubscriptionsTable.findFirst({ where: { paddleSubscriptionId } });
}

export async function getSubscriptionsForProfile(profileId: string): Promise<BillingSubscription[]> {
  return db.query.billingSubscriptionsTable.findMany({ where: { profileId } });
}

type SubscriptionValues = Omit<typeof billingSubscriptionsTable.$inferInsert, "id" | "createdAt" | "updatedAt">;

export async function upsertSubscription(values: SubscriptionValues): Promise<void> {
  // The owner is fixed at creation; later events only update the state
  const { profileId, paddleSubscriptionId, ...changes } = values;
  await db
    .insert(billingSubscriptionsTable)
    .values({ profileId, paddleSubscriptionId, ...changes })
    .onConflictDoUpdate({ target: billingSubscriptionsTable.paddleSubscriptionId, set: changes });
}

export async function setProfilePlan(
  profileId: string,
  plan: PlanId,
  autoScanIntervalMinutes: number | null | undefined,
): Promise<void> {
  await db
    .update(profilesTable)
    .set({ plan, ...(autoScanIntervalMinutes !== undefined ? { autoScanIntervalMinutes } : {}) })
    .where(eq(profilesTable.id, profileId));
}
