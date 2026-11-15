// Day 23: Paddle webhooks. Signatures are checked, events apply once and in
// order, and profiles.plan follows the subscription. No request reaches Paddle;
// the database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq, like } from "drizzle-orm";

import { POST } from "@/app/api/webhooks/paddle/route";
import db from "@/db";
import * as s from "@/db/schema";
import { PLANS } from "@/lib/billing/plans";
import { PaddleNotConfiguredError } from "@/lib/paddle/api";
import { verifyPaddleSignature } from "@/lib/paddle/webhook";
import { changePlan, getBillingOverview, openBillingPortal } from "@/services/billing/account";
import { handlePaddleEvent } from "@/services/billing/paddleWebhook";
import { autoScanInterval } from "@/services/scheduler/tick";

import { cleanup, getProfile, newProfile, rememberXUsage } from "./helpers/db";

const SECRET = "pdl_ntfset_test_secret";
const STARTER = "pri_test_starter";
const PRO = "pri_test_pro";
const RUN = `evt_test_${Date.now()}_`;

before(async () => {
  await rememberXUsage();
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT = "sandbox";
  process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = "test_0000000000000000000000000";
  process.env.NEXT_PUBLIC_PADDLE_STARTER_PRICE_ID = STARTER;
  process.env.NEXT_PUBLIC_PADDLE_PRO_PRICE_ID = PRO;
});
after(async () => {
  await db.delete(s.paddleWebhookEventsTable).where(like(s.paddleWebhookEventsTable.eventId, `${RUN}%`));
  await cleanup();
});

let n = 0;
function subscriptionEvent(
  type: string,
  sub: { id: string; userId?: string; status?: string; priceId?: string; at?: string },
) {
  return {
    event_id: `${RUN}${++n}`,
    event_type: type,
    occurred_at: sub.at ?? new Date().toISOString(),
    data: {
      id: sub.id,
      status: sub.status ?? "active",
      customer_id: "ctm_test",
      custom_data: sub.userId ? { userId: sub.userId } : null,
      items: [{ price: { id: sub.priceId ?? STARTER } }],
      current_billing_period: { starts_at: "2026-11-13T00:00:00Z", ends_at: "2026-12-13T00:00:00Z" },
      scheduled_change: null,
    },
  };
}

function sign(body: string, ts = Math.floor(Date.now() / 1000)) {
  return `ts=${ts};h1=${createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex")}`;
}

test("signatures: valid accepted; tampered, wrong secret, old or missing refused", () => {
  const body = '{"event_id":"evt_1"}';
  assert.ok(verifyPaddleSignature(body, sign(body), SECRET));
  assert.equal(verifyPaddleSignature(body + " ", sign(body), SECRET), false, "body changed");
  assert.equal(verifyPaddleSignature(body, sign(body), "pdl_ntfset_other"), false, "other secret");
  assert.equal(verifyPaddleSignature(body, sign(body, Math.floor(Date.now() / 1000) - 3600), SECRET), false, "replayed later");
  assert.equal(verifyPaddleSignature(body, null, SECRET), false);
  assert.equal(verifyPaddleSignature(body, "ts=1;h1=zz", SECRET), false);
  // During secret rotation Paddle sends several h1 values; any valid one counts
  const ts = Math.floor(Date.now() / 1000);
  const valid = sign(body, ts).split("h1=")[1];
  assert.ok(verifyPaddleSignature(body, `ts=${ts};h1=${"0".repeat(64)};h1=${valid}`, SECRET));
});

test("route: unsigned requests are refused and change nothing", async () => {
  const p = await newProfile();
  const body = JSON.stringify(subscriptionEvent("subscription.created", { id: `sub_${randomUUID()}`, userId: p.userId }));
  const response = await POST(new Request("https://scout.test/api/webhooks/paddle", { method: "POST", body }));
  assert.equal(response.status, 401);
  assert.equal((await getProfile(p.id)).plan, "free");

  const signed = await POST(
    new Request("https://scout.test/api/webhooks/paddle", { method: "POST", body, headers: { "paddle-signature": sign(body) } }),
  );
  assert.equal(signed.status, 200);
  assert.deepEqual(await signed.json(), { outcome: "applied" });
  assert.equal((await getProfile(p.id)).plan, "starter");
});

test("lifecycle: activate, upgrade, cancel; retries and late events change nothing", async () => {
  const p = await newProfile();
  const id = `sub_${randomUUID()}`;
  const t = (minutes: number) => new Date(Date.UTC(2026, 10, 13, 22, minutes)).toISOString();

  const created = subscriptionEvent("subscription.created", { id, userId: p.userId, at: t(0) });
  assert.equal(await handlePaddleEvent(created), "applied");
  assert.equal((await getProfile(p.id)).plan, "starter");
  assert.equal(await handlePaddleEvent(created), "duplicate", "Paddle retry");

  // Later events may omit custom_data: the stored subscription knows the user
  assert.equal(await handlePaddleEvent(subscriptionEvent("subscription.updated", { id, priceId: PRO, at: t(10) })), "applied");
  assert.equal((await getProfile(p.id)).plan, "pro");

  // An older event delivered late doesn't undo the upgrade
  assert.equal(await handlePaddleEvent(subscriptionEvent("subscription.activated", { id, at: t(5) })), "stale");
  assert.equal((await getProfile(p.id)).plan, "pro");

  // Payment trouble keeps access while Paddle retries; cancellation ends it
  await handlePaddleEvent(subscriptionEvent("subscription.past_due", { id, priceId: PRO, status: "past_due", at: t(20) }));
  assert.equal((await getProfile(p.id)).plan, "pro");
  await handlePaddleEvent(subscriptionEvent("subscription.canceled", { id, priceId: PRO, status: "canceled", at: t(30) }));
  assert.equal((await getProfile(p.id)).plan, "free");

  const [row] = await db.select().from(s.billingSubscriptionsTable).where(eq(s.billingSubscriptionsTable.paddleSubscriptionId, id));
  assert.equal(row.status, "canceled");
  assert.equal(row.profileId, p.id);
});

test("unknown users, unknown prices, internal accounts and other events", async () => {
  assert.equal(
    await handlePaddleEvent(subscriptionEvent("subscription.created", { id: `sub_${randomUUID()}`, userId: "nobody" })),
    "unmatched",
  );

  const p = await newProfile();
  await handlePaddleEvent(subscriptionEvent("subscription.created", { id: `sub_${randomUUID()}`, userId: p.userId, priceId: "pri_other" }));
  assert.equal((await getProfile(p.id)).plan, "free", "a price Scout doesn't sell grants nothing");

  const internal = await newProfile();
  await db.update(s.profilesTable).set({ plan: "internal" }).where(eq(s.profilesTable.id, internal.id));
  const sub = `sub_${randomUUID()}`;
  await handlePaddleEvent(subscriptionEvent("subscription.created", { id: sub, userId: internal.userId }));
  await handlePaddleEvent(subscriptionEvent("subscription.canceled", { id: sub, status: "canceled" }));
  assert.equal((await getProfile(internal.id)).plan, "internal", "billing never touches internal accounts");

  assert.equal(
    await handlePaddleEvent({ event_id: `${RUN}tx`, event_type: "transaction.completed", occurred_at: new Date().toISOString(), data: {} }),
    "ignored",
  );
});

test("plan changes keep the chosen auto-scan interval; the scheduler applies what the plan offers", async () => {
  const p = await newProfile();
  const id = `sub_${randomUUID()}`;
  await handlePaddleEvent(subscriptionEvent("subscription.created", { id, userId: p.userId, priceId: PRO, at: "2026-11-13T10:00:00Z" }));
  await db.update(s.profilesTable).set({ autoScanIntervalMinutes: 30 }).where(eq(s.profilesTable.id, p.id));
  await handlePaddleEvent(subscriptionEvent("subscription.canceled", { id, priceId: PRO, status: "canceled", at: "2026-11-13T11:00:00Z" }));
  const after = await getProfile(p.id);
  assert.equal(after.plan, "free");
  assert.equal(after.autoScanIntervalMinutes, 30, "kept for when the user upgrades again");
  assert.equal(autoScanInterval(after), PLANS.free.autoScan.intervalsMinutes[0], "Free's default meanwhile");
});

// --- Plan & billing: switching plans and the customer portal (Paddle API mocked) ---

type PaddleCall = { method: string; path: string; body: Record<string, unknown> };
const paddleCalls: PaddleCall[] = [];

function mockPaddleApi(respond: (call: PaddleCall) => unknown) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // The test database (Neon, over HTTP) passes; Paddle is answered here; nothing else may leave
    if (url.hostname.endsWith(".neon.tech")) return previous(input, init);
    if (url.hostname !== "sandbox-api.paddle.com") throw new Error(`Unexpected request to ${url.hostname}`);
    const call = { method: init?.method ?? "GET", path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) };
    paddleCalls.push(call);
    return new Response(JSON.stringify(respond(call)), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

async function subscribedProfile(priceId: string) {
  const p = await newProfile();
  const id = `sub_${randomUUID()}`;
  await handlePaddleEvent(subscriptionEvent("subscription.created", { id, userId: p.userId, priceId, at: "2026-11-15T10:00:00Z" }));
  return { p, id };
}

test("switching plans updates the same subscription and the plan at once", async () => {
  process.env.PADDLE_API_KEY = "pdl_sdbx_apikey_test";
  const { p, id } = await subscribedProfile(PRO);
  const restore = mockPaddleApi((call) => ({
    data: {
      id,
      status: "active",
      customer_id: "ctm_test",
      custom_data: null,
      items: [{ price: { id: (call.body.items as { price_id: string }[])[0].price_id } }],
      current_billing_period: { ends_at: "2026-12-15T00:00:00Z" },
      scheduled_change: null,
      updated_at: "2026-11-15T11:00:00Z",
    },
  }));
  try {
    const profile = await getProfile(p.id);
    assert.deepEqual(await changePlan(profile, "pro"), { ok: false, message: "You're already on this plan." });

    assert.deepEqual(await changePlan(profile, "starter"), { ok: true, plan: "starter" });
    const call = paddleCalls.at(-1)!;
    assert.equal(call.method, "PATCH");
    assert.equal(call.path, `/subscriptions/${id}`);
    assert.equal(call.body.proration_billing_mode, "prorated_next_billing_period", "downgrade: credit next bill");
    assert.equal((await getProfile(p.id)).plan, "starter");

    await changePlan(await getProfile(p.id), "pro");
    assert.equal(paddleCalls.at(-1)!.body.proration_billing_mode, "prorated_immediately", "upgrade: charged now");
    assert.equal((await getProfile(p.id)).plan, "pro");

    const overview = await getBillingOverview(await getProfile(p.id));
    assert.equal(overview.subscription?.plan, "pro");
    assert.equal(overview.subscription?.changeBlockedBy, null);
    assert.ok(overview.hasBillingAccount);
  } finally {
    restore();
  }
});

test("plan switches are refused without a subscription, during a scheduled cancel, or without an API key", async () => {
  const restore = mockPaddleApi(() => {
    throw new Error("must not be called");
  });
  try {
    const free = await newProfile();
    assert.equal((await changePlan(free, "pro")).ok, false);

    const { p, id } = await subscribedProfile(STARTER);
    const canceling = subscriptionEvent("subscription.updated", { id, at: "2026-11-15T12:00:00Z" });
    (canceling.data as Record<string, unknown>).scheduled_change = { action: "cancel", effective_at: "2026-12-15T00:00:00Z" };
    await handlePaddleEvent(canceling);
    const result = await changePlan(await getProfile(p.id), "pro");
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /scheduled change/);
    assert.equal((await getProfile(p.id)).plan, "starter", "still Starter until the period ends");

    const other = await subscribedProfile(STARTER);
    process.env.PADDLE_API_KEY = "";
    await assert.rejects(changePlan(await getProfile(other.p.id), "pro"), PaddleNotConfiguredError);
    assert.equal(paddleCalls.filter((c) => c.path.includes(other.id)).length, 0);
  } finally {
    restore();
  }
});

test("Manage billing opens a portal session for the user's own Paddle customer", async () => {
  process.env.PADDLE_API_KEY = "pdl_sdbx_apikey_test";
  const restore = mockPaddleApi(() => ({
    data: { urls: { general: { overview: "https://customer-portal.paddle.com/cpl_test" } } },
  }));
  try {
    assert.equal(await openBillingPortal(await newProfile()), null, "no billing account yet");
    const { p, id } = await subscribedProfile(PRO);
    assert.equal(await openBillingPortal(p), "https://customer-portal.paddle.com/cpl_test");
    const call = paddleCalls.at(-1)!;
    assert.equal(call.path, "/customers/ctm_test/portal-sessions");
    assert.deepEqual(call.body.subscription_ids, [id]);
  } finally {
    restore();
  }
});
