// Day 23: Paddle billing. Signatures are checked, events apply once, Paddle's
// current subscription state wins over the order events arrive in, a user
// never holds two paid subscriptions, and profiles.plan follows. Paddle is a
// fake in this file (no request leaves the machine); the database is the
// isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { eq, like } from "drizzle-orm";

import { POST } from "@/app/api/webhooks/paddle/route";
import db from "@/db";
import * as s from "@/db/schema";
import { PLANS } from "@/lib/billing/plans";
import { createCheckoutBinding } from "@/lib/paddle/binding";
import { verifyPaddleSignature } from "@/lib/paddle/webhook";
import { getScoutLimits } from "@/lib/scout/testLimits";
import {
  cancelAtPeriodEnd,
  changePlan,
  checkoutConfirmation,
  getBillingOverview,
  keepSubscription,
  openBillingPortal,
  prepareCheckout,
} from "@/services/billing/account";
import { maxActiveWatchlist } from "@/services/billing/budget";
import { handlePaddleEvent } from "@/services/billing/paddleWebhook";
import { autoScanInterval } from "@/services/scheduler/tick";

import { cleanup, getProfile, newProfile, rememberXUsage } from "./helpers/db";

const SECRET = "pdl_ntfset_test_secret";
const API_KEY = "pdl_sdbx_apikey_test";
const STARTER = "pri_test_starter";
const PRO = "pri_test_pro";
const RUN = `evt_test_${Date.now()}_`;

// --- A fake Paddle: subscriptions as Paddle currently holds them ---

type Entity = {
  id: string;
  status: string;
  customer_id: string;
  custom_data: Record<string, unknown> | null;
  items: { price: { id: string; unit_price: { amount: string; currency_code: string } } }[];
  current_billing_period: { starts_at: string; ends_at: string } | null;
  scheduled_change: { action: string; effective_at: string } | null;
  created_at: string;
  updated_at: string;
};

const paddle = new Map<string, Entity>();
const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
let clock = Date.UTC(2026, 10, 15, 10, 0);
const tick = () => new Date((clock += 60_000)).toISOString();

function priceItem(priceId: string) {
  return [{ price: { id: priceId, unit_price: { amount: priceId === PRO ? "2400" : "1200", currency_code: "USD" } } }];
}

const realFetch = globalThis.fetch;
function installFakePaddle() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // The test database (Neon over HTTP) passes; nothing else may leave
    if (url.hostname.endsWith(".neon.tech")) return realFetch(input, init);
    if (url.hostname !== "sandbox-api.paddle.com") throw new Error(`Unexpected request to ${url.hostname}`);
    const method = init?.method ?? "GET";
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, path: url.pathname, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

    const portal = url.pathname.match(/^\/customers\/([^/]+)\/portal-sessions$/);
    if (portal) return json({ data: { urls: { general: { overview: `https://customer-portal.paddle.com/${portal[1]}` } } } });

    const match = url.pathname.match(/^\/subscriptions\/([^/]+)(\/cancel)?$/);
    const entity = match && paddle.get(match[1]);
    if (!entity) return json({ error: { code: "not_found", detail: "Not found" } }, 404);
    if (match[2]) {
      if (body.effective_from === "immediately") Object.assign(entity, { status: "canceled", scheduled_change: null });
      else entity.scheduled_change = { action: "cancel", effective_at: entity.current_billing_period!.ends_at };
      entity.updated_at = tick();
    } else if (method === "PATCH") {
      if (body.items) entity.items = priceItem((body.items as { price_id: string }[])[0].price_id);
      if ("scheduled_change" in body) entity.scheduled_change = null;
      entity.updated_at = tick();
    }
    return json({ data: structuredClone(entity) });
  }) as typeof fetch;
}

/** Paddle's state changes, then it sends the event carrying that state */
/** What Scout's server attaches to a checkout it allowed (see prepareCheckout) */
function bindingFor(userId: string, priceId: string, at = new Date(clock)) {
  return { scoutBinding: createCheckoutBinding({ userId, tier: priceId === PRO ? "pro" : "starter" }, at) };
}

function setState(id: string, changes: Partial<Entity> & { priceId?: string; userId?: string }): Entity {
  const { priceId, userId, ...rest } = changes;
  const current: Entity = paddle.get(id) ?? {
    id,
    status: "active",
    customer_id: "ctm_test",
    custom_data: null,
    items: priceItem(STARTER),
    current_billing_period: { starts_at: "2026-11-15T00:00:00Z", ends_at: "2026-12-15T00:00:00Z" },
    scheduled_change: null,
    created_at: new Date(clock).toISOString(),
    updated_at: tick(),
  };
  const next = { ...current, ...rest, updated_at: tick() };
  if (priceId) next.items = priceItem(priceId);
  if (userId) next.custom_data = bindingFor(userId, priceId ?? next.items[0].price.id);
  paddle.set(id, next);
  return structuredClone(next);
}

let n = 0;
function event(type: string, data: unknown, occurredAt = new Date(clock).toISOString()) {
  return { event_id: `${RUN}${++n}`, event_type: type, occurred_at: occurredAt, data };
}

async function subscribed(priceId: string) {
  const p = await newProfile();
  const id = `sub_${randomUUID()}`;
  await handlePaddleEvent(event("subscription.created", setState(id, { userId: p.userId, priceId })));
  return { p, id };
}

before(async () => {
  await rememberXUsage();
  installFakePaddle();
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT = "sandbox";
  process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = "test_0000000000000000000000000";
  process.env.NEXT_PUBLIC_PADDLE_STARTER_PRICE_ID = STARTER;
  process.env.NEXT_PUBLIC_PADDLE_PRO_PRICE_ID = PRO;
});
// Every test starts with the fake API key; one test removes it on purpose
beforeEach(() => {
  process.env.PADDLE_API_KEY = API_KEY;
});
after(async () => {
  globalThis.fetch = realFetch;
  await db.delete(s.paddleWebhookEventsTable).where(like(s.paddleWebhookEventsTable.eventId, `${RUN}%`));
  await cleanup();
});

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
  const body = JSON.stringify(event("subscription.created", setState(`sub_${randomUUID()}`, { userId: p.userId })));
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

test("lifecycle: Paddle's current state wins, whatever order events arrive in", async () => {
  const { p, id } = await subscribed(STARTER);
  assert.equal((await getProfile(p.id)).plan, "starter");
  const [row] = await db.select().from(s.billingSubscriptionsTable).where(eq(s.billingSubscriptionsTable.paddleSubscriptionId, id));
  assert.deepEqual(row.unitPrice, { amount: "1200", currencyCode: "USD" });

  // An upgrade happens in Paddle; its event is delayed behind an older one
  const before = structuredClone(paddle.get(id)!);
  const upgraded = setState(id, { priceId: PRO });
  const late = event("subscription.activated", { ...before, updated_at: "2026-01-01T00:00:00Z" });
  assert.equal(await handlePaddleEvent(late), "applied", "reconciled against Paddle, not the stale payload");
  assert.equal((await getProfile(p.id)).plan, "pro");
  const again = event("subscription.updated", upgraded);
  assert.equal(await handlePaddleEvent(again), "applied");
  assert.equal(await handlePaddleEvent(again), "duplicate", "Paddle retry");

  // A renewal: the transaction event refreshes the period from Paddle
  setState(id, { current_billing_period: { starts_at: "2026-12-15T00:00:00Z", ends_at: "2027-01-15T00:00:00Z" } });
  assert.equal(await handlePaddleEvent(event("transaction.completed", { subscription_id: id })), "applied");
  const [renewed] = await db.select().from(s.billingSubscriptionsTable).where(eq(s.billingSubscriptionsTable.paddleSubscriptionId, id));
  assert.equal(renewed.currentPeriodEndsAt?.toISOString(), "2027-01-15T00:00:00.000Z");

  // Payment trouble keeps access while Paddle retries; cancellation ends it
  await handlePaddleEvent(event("transaction.payment_failed", { subscription_id: id }));
  await handlePaddleEvent(event("subscription.past_due", setState(id, { status: "past_due" })));
  assert.equal((await getProfile(p.id)).plan, "pro");
  await handlePaddleEvent(event("subscription.paused", setState(id, { status: "paused" })));
  assert.equal((await getProfile(p.id)).plan, "free", "paused: no paid access");
  await handlePaddleEvent(event("subscription.resumed", setState(id, { status: "active" })));
  assert.equal((await getProfile(p.id)).plan, "pro");
  await handlePaddleEvent(event("subscription.canceled", setState(id, { status: "canceled" })));
  assert.equal((await getProfile(p.id)).plan, "free");
});

test("without an API key, event payloads apply in order of their time", async () => {
  delete process.env.PADDLE_API_KEY;
  const p = await newProfile();
  const id = `sub_${randomUUID()}`;
  const t = (minutes: number) => new Date(Date.UTC(2026, 10, 13, 22, minutes)).toISOString();
  const base = setState(id, { userId: p.userId });
  await handlePaddleEvent(event("subscription.created", base, t(0)));
  await handlePaddleEvent(event("subscription.updated", { ...base, items: priceItem(PRO) }, t(10)));
  assert.equal(await handlePaddleEvent(event("subscription.activated", base, t(5))), "stale");
  assert.equal((await getProfile(p.id)).plan, "pro");
  assert.equal(await handlePaddleEvent(event("transaction.completed", { subscription_id: id })), "ignored");
});

test("a second paid subscription for the same user is canceled, never stacked", async () => {
  const { p, id: first } = await subscribed(STARTER);
  const second = `sub_${randomUUID()}`;
  assert.equal(
    await handlePaddleEvent(event("subscription.created", setState(second, { userId: p.userId, priceId: PRO }))),
    "duplicate_canceled",
  );
  assert.equal(paddle.get(second)!.status, "canceled", "canceled in Paddle");
  assert.equal((await getProfile(p.id)).plan, "starter", "the first subscription is kept");
  const rows = await db.select().from(s.billingSubscriptionsTable).where(eq(s.billingSubscriptionsTable.profileId, p.id));
  assert.deepEqual(rows.map((r) => [r.paddleSubscriptionId, r.status]).sort(), [[first, "active"], [second, "canceled"]].sort());

  // The database refuses two at once even if the service were bypassed
  await assert.rejects(
    db.insert(s.billingSubscriptionsTable).values({
      profileId: p.id,
      paddleSubscriptionId: `sub_${randomUUID()}`,
      paddleCustomerId: "ctm_test",
      status: "active",
      lastEventAt: new Date(),
    }),
  );

  // Not a duplicate when the first one already ended in Paddle (its event not here yet)
  setState(first, { status: "canceled" });
  const third = `sub_${randomUUID()}`;
  assert.equal(await handlePaddleEvent(event("subscription.created", setState(third, { userId: p.userId, priceId: PRO }))), "applied");
  assert.equal((await getProfile(p.id)).plan, "pro");

  // Without an API key a duplicate can't be resolved safely: it fails, Paddle retries
  delete process.env.PADDLE_API_KEY;
  const fourth = `sub_${randomUUID()}`;
  await assert.rejects(handlePaddleEvent(event("subscription.created", setState(fourth, { userId: p.userId }))));
});

test("unknown users, unknown prices, internal accounts and other events", async () => {
  assert.equal(await handlePaddleEvent(event("subscription.created", setState(`sub_${randomUUID()}`, { userId: "nobody" }))), "unmatched");

  const p = await newProfile();
  await handlePaddleEvent(event("subscription.created", setState(`sub_${randomUUID()}`, { userId: p.userId, priceId: "pri_other" })));
  assert.equal((await getProfile(p.id)).plan, "free", "a price Scout doesn't sell grants nothing");

  const internal = await newProfile();
  await db.update(s.profilesTable).set({ plan: "internal" }).where(eq(s.profilesTable.id, internal.id));
  const sub = `sub_${randomUUID()}`;
  await handlePaddleEvent(event("subscription.created", setState(sub, { userId: internal.userId })));
  await handlePaddleEvent(event("subscription.canceled", setState(sub, { status: "canceled" })));
  assert.equal((await getProfile(internal.id)).plan, "internal", "billing never touches internal accounts");

  assert.equal(await handlePaddleEvent(event("transaction.completed", { subscription_id: null })), "ignored");
  assert.equal(await handlePaddleEvent(event("customer.updated", {})), "ignored");
});

test("checkout: the server picks the price, binds the account and refuses a second subscription", async () => {
  const free = await newProfile();
  const prepared = await prepareCheckout(free, "pro");
  assert.ok(prepared.ok && prepared.priceId === PRO && prepared.binding.startsWith("v1."));
  const { p } = await subscribed(STARTER);
  const refused = await prepareCheckout(await getProfile(p.id), "pro");
  assert.equal(refused.ok, false);

  // The success page waits for the webhook, then confirms
  const since = new Date(Date.now() - 60_000);
  assert.deepEqual(await checkoutConfirmation(free, since), { status: "pending" });
  assert.deepEqual(await checkoutConfirmation(p, since), { status: "confirmed", plan: "starter" });
});

test("switching plans changes the same subscription, with the right proration", async () => {
  const { p, id } = await subscribed(PRO);
  assert.deepEqual(await changePlan(await getProfile(p.id), "pro"), { ok: false, message: "You're already on this plan." });

  assert.deepEqual(await changePlan(await getProfile(p.id), "starter"), { ok: true, plan: "starter" });
  let call = calls.findLast((c) => c.method === "PATCH")!;
  assert.equal(call.path, `/subscriptions/${id}`);
  assert.equal(call.body.proration_billing_mode, "prorated_next_billing_period", "downgrade: credit next bill");
  assert.equal((await getProfile(p.id)).plan, "starter");

  await changePlan(await getProfile(p.id), "pro");
  call = calls.findLast((c) => c.method === "PATCH")!;
  assert.equal(call.body.proration_billing_mode, "prorated_immediately", "upgrade: charged now");
  assert.equal((await getProfile(p.id)).plan, "pro");

  const overview = await getBillingOverview(await getProfile(p.id));
  assert.equal(overview.subscription?.plan, "pro");
  assert.deepEqual(overview.subscription?.unitPrice, { amount: "2400", currencyCode: "USD" });

  assert.equal((await changePlan(await newProfile(), "pro")).ok, false, "no subscription to change");
});

test("cancel at period end keeps the plan until then; keeping it undoes that", async () => {
  const { p, id } = await subscribed(STARTER);
  const result = await cancelAtPeriodEnd(p);
  assert.equal(result.ok, true);
  assert.equal(paddle.get(id)!.scheduled_change?.action, "cancel");
  assert.equal((await getProfile(p.id)).plan, "starter", "access continues until the period ends");
  const overview = await getBillingOverview(p);
  assert.equal(overview.subscription?.scheduledChange?.action, "cancel");
  assert.match(overview.subscription?.changeBlockedBy ?? "", /ends .*Keep it first/);
  assert.equal((await changePlan(p, "pro")).ok, false, "no switching while set to end");

  assert.equal((await keepSubscription(p)).ok, true);
  assert.equal(paddle.get(id)!.scheduled_change, null);
  assert.equal((await getBillingOverview(p)).subscription?.scheduledChange, null);

  // When the period ends Paddle cancels it; data stays, the plan returns to Free
  await cancelAtPeriodEnd(p);
  await handlePaddleEvent(event("subscription.canceled", setState(id, { status: "canceled", scheduled_change: null })));
  assert.equal((await getProfile(p.id)).plan, "free");
  assert.ok(await getProfile(p.id), "the profile and its data remain");
});

test("Manage billing opens a portal session for the user's own Paddle customer", async () => {
  assert.equal(await openBillingPortal(await newProfile()), null, "no billing account yet");
  const { p, id } = await subscribed(PRO);
  assert.equal(await openBillingPortal(p), "https://customer-portal.paddle.com/ctm_test");
  const call = calls.at(-1)!;
  assert.equal(call.path, "/customers/ctm_test/portal-sessions");
  assert.deepEqual(call.body.subscription_ids, [id]);
});

test("testing mode keeps its caps for Free, not for paying plans", async () => {
  const previous = process.env.SCOUT_TEST_MODE;
  process.env.SCOUT_TEST_MODE = "true";
  try {
    assert.equal(getScoutLimits("free").maxRunsPerDay, 3);
    assert.equal(getScoutLimits("pro").maxRunsPerDay, null);
    assert.equal(getScoutLimits("starter").minMinutesBetweenRuns, null);
    // The global X spending caps stay for everyone
    assert.equal(getScoutLimits("pro").maxXPostReadsPerDay, getScoutLimits("free").maxXPostReadsPerDay);
    assert.equal(maxActiveWatchlist({ plan: "pro", usageLimitOverrides: null }), PLANS.pro.limits.maxActiveWatchlist);
    assert.equal(maxActiveWatchlist({ plan: "free", usageLimitOverrides: null }), PLANS.free.limits.maxActiveWatchlist);
  } finally {
    process.env.SCOUT_TEST_MODE = previous;
  }
});

test("plan changes keep the chosen auto-scan interval; the scheduler applies what the plan offers", async () => {
  const { p, id } = await subscribed(PRO);
  await db.update(s.profilesTable).set({ autoScanIntervalMinutes: 30 }).where(eq(s.profilesTable.id, p.id));
  await handlePaddleEvent(event("subscription.canceled", setState(id, { status: "canceled" })));
  const after = await getProfile(p.id);
  assert.equal(after.plan, "free");
  assert.equal(after.autoScanIntervalMinutes, 30, "kept for when the user upgrades again");
  assert.equal(autoScanInterval(after), PLANS.free.autoScan.intervalsMinutes[0], "Free's default meanwhile");
});

test("account binding: only a valid, unexpired server binding links a subscription", async () => {
  const victim = await newProfile();
  // A plain userId (what a browser could write into customData) isn't accepted
  const forged = `sub_${randomUUID()}`;
  setState(forged, { custom_data: { userId: victim.userId } });
  assert.equal(await handlePaddleEvent(event("subscription.created", paddle.get(forged)!)), "unmatched");

  // A binding with a tampered payload or signature isn't accepted
  const real = bindingFor(victim.userId, STARTER).scoutBinding;
  const [v, body, sig] = real.split(".");
  const tampered = `sub_${randomUUID()}`;
  setState(tampered, { custom_data: { scoutBinding: `${v}.${body}.${sig.slice(0, -2)}xx` } });
  assert.equal(await handlePaddleEvent(event("subscription.created", paddle.get(tampered)!)), "unmatched");

  // A binding used after it expired isn't accepted (checkout three hours later)
  const late = `sub_${randomUUID()}`;
  const oldBinding = bindingFor(victim.userId, STARTER, new Date(clock - 3 * 60 * 60_000));
  setState(late, { custom_data: oldBinding });
  assert.equal(await handlePaddleEvent(event("subscription.created", paddle.get(late)!)), "unmatched");
  assert.equal((await getProfile(victim.id)).plan, "free", "nobody gained or lost a plan");

  // A webhook retried days later still verifies: validity is checked at checkout time
  const retried = `sub_${randomUUID()}`;
  setState(retried, { userId: victim.userId });
  clock += 3 * 86_400_000;
  assert.equal(await handlePaddleEvent(event("subscription.created", paddle.get(retried)!)), "applied");
  assert.equal((await getProfile(victim.id)).plan, "starter");
});

test("internal accounts can't start a checkout", async () => {
  const internal = await newProfile();
  await db.update(s.profilesTable).set({ plan: "internal" }).where(eq(s.profilesTable.id, internal.id));
  const result = await prepareCheckout(await getProfile(internal.id), "pro");
  assert.deepEqual(result, { ok: false, message: "Internal accounts aren't billed and can't subscribe." });
});

test("refunds: a full approved refund or chargeback ends paid access; partial ones don't", async () => {
  const adjustment = (id: string, action: string, type: string, status: string) =>
    event("adjustment.updated", { id: `adj_${randomUUID()}`, action, type, status, subscription_id: id, transaction_id: "txn_test" });

  const { p, id } = await subscribed(PRO);
  assert.equal(await handlePaddleEvent(adjustment(id, "refund", "full", "pending_approval")), "ignored", "not money back yet");
  assert.equal(await handlePaddleEvent(adjustment(id, "refund", "partial", "approved")), "adjustment_noted");
  assert.equal((await getProfile(p.id)).plan, "pro", "a partial refund keeps the plan");

  assert.equal(await handlePaddleEvent(adjustment(id, "refund", "full", "approved")), "refund_canceled");
  assert.equal(paddle.get(id)!.status, "canceled", "canceled in Paddle");
  assert.equal((await getProfile(p.id)).plan, "free");

  const other = await subscribed(STARTER);
  assert.equal(await handlePaddleEvent(adjustment(other.id, "chargeback", "full", "approved")), "refund_canceled");
  assert.equal((await getProfile(other.p.id)).plan, "free");

  // Refunds of payments without a subscription are noted, nothing else changes
  assert.equal(
    await handlePaddleEvent(event("adjustment.created", { id: "adj_x", action: "refund", type: "full", status: "approved", subscription_id: null })),
    "adjustment_noted",
  );
});
