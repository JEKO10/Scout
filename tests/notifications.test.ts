// Day 19: smart notifications and Slack. Slack, X and OpenAI are mocked;
// every test profile, its Slack connection and its notifications live in the
// development database and are deleted afterwards.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import db from "@/db";
import {
  countUnreadNotifications,
  getDailyCount,
  getSlackConnection,
  markNotificationsRead,
  saveNotificationSettings,
} from "@/db/queries/notifications";
import { getOpportunityForProfile } from "@/db/queries/opportunities";
import * as s from "@/db/schema";
import { decryptToken } from "@/lib/crypto/tokens";
import { isQuietHours, localDay } from "@/lib/notifications/rules";
import { createSlackOAuthState, slackAuthorizeUrl, slackRedirectUri } from "@/lib/slack/oauth";
import { deliverPendingNotifications } from "@/services/notifications/deliver";
import { queueRunNotifications } from "@/services/notifications/queue";
import {
  chooseSlackChannel,
  disconnectSlack,
  handleSlackOAuthCallback,
  listSlackChannels,
  sendSlackTestMessage,
} from "@/services/notifications/slackConnection";
import { runSchedulerTick } from "@/services/scheduler/tick";

import { cleanup, newProfile, rememberXUsage, watch } from "./helpers/db";
import { addTweets, ai, installMocks, slack, x } from "./helpers/mocks";

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);
beforeEach(() => {
  slack.calls.length = 0;
  slack.replies.clear();
});

let seq = 0;
const team = () => `T${Date.now().toString(36)}${seq++}`.toUpperCase();
const CHANNEL = "C0ALERTS01";

async function onboarded() {
  const p = await newProfile();
  await db.update(s.profilesTable).set({ onboardingCompleted: true }).where(eq(s.profilesTable.id, p.id));
  return p;
}

/** Connects through the real OAuth callback logic, as the route does. */
async function connect(profileId: string, teamId = team()) {
  const { state, cookie } = createSlackOAuthState(profileId);
  const result = await handleSlackOAuthCallback(profileId, {
    state,
    cookie,
    code: `team:${teamId}`,
    error: null,
  });
  assert.equal(result, "connected");
  return teamId;
}

/** A profile with Slack connected, a channel chosen and alerts on. */
async function slackUser(settings: Partial<typeof s.notificationSettingsTable.$inferInsert> = {}) {
  const p = await onboarded();
  const teamId = await connect(p.id);
  assert.ok((await chooseSlackChannel(p.id, CHANNEL)).ok);
  await saveNotificationSettings(p.id, { slackEnabled: true, timezone: "UTC", ...settings });
  slack.calls.length = 0;
  return { profile: p, teamId };
}

/** A completed automatic run with these opportunities (score, post age in hours). */
async function runWith(profileId: string, items: { score: number; ageHours?: number }[]) {
  const [run] = await db
    .insert(s.scoutRunsTable)
    .values({ profileId, status: "completed", trigger: "auto", completedAt: new Date() })
    .returning();
  const opportunities = await db
    .insert(s.opportunitiesTable)
    .values(
      items.map((item, index) => ({
        scoutRunId: run.id,
        profileId,
        platform: "x" as const,
        platformPostId: `n${Date.now()}${seq++}`,
        postUrl: "https://x.com/founder/status/1",
        authorHandle: "founder",
        content: `What's the best way to grow on X? <post ${index}>`,
        score: item.score,
        reason: "Strong match with your expertise and growth goals.",
        suggestedAngle: "PRIVATE ANGLE FROM THE BRAIN",
        topic: "Growth",
        postedAt: new Date(Date.now() - (item.ageHours ?? 1) * 3600_000),
      })),
    )
    .returning();
  return { run, opportunities };
}

const deliveriesOf = (profileId: string) =>
  db.select().from(s.notificationDeliveriesTable).where(eq(s.notificationDeliveriesTable.profileId, profileId));
const notificationsOf = (profileId: string) =>
  db.select().from(s.notificationsTable).where(eq(s.notificationsTable.profileId, profileId));
/** Messages posted with this workspace's token: one user's alerts */
const sentTo = (teamId: string) => slack.messages().filter((call) => call.token === `xoxb-${teamId}`);
const deliver = () => deliverPendingNotifications({ maxDeliveries: 50 });
/** Makes retried deliveries due now instead of after their backoff. */
const dueNow = (profileId: string) =>
  db
    .update(s.notificationDeliveriesTable)
    .set({ runAfter: sql`now()` })
    .where(eq(s.notificationDeliveriesTable.profileId, profileId));

test("1: Slack OAuth: authorize URL, callback, encrypted token", async () => {
  const p = await onboarded();
  const { state, cookie } = createSlackOAuthState(p.id);
  const url = new URL(slackAuthorizeUrl(state));
  assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize");
  assert.equal(url.searchParams.get("client_id"), "test-client-id");
  assert.equal(url.searchParams.get("scope"), "chat:write,channels:read,channels:join");
  assert.equal(url.searchParams.get("redirect_uri"), "https://scout.test/api/slack/oauth/callback");
  assert.equal(url.searchParams.get("state"), state);

  const teamId = team();
  const result = await handleSlackOAuthCallback(p.id, { state, cookie, code: `team:${teamId}`, error: null });
  assert.equal(result, "connected");
  const exchange = slack.calls.find((call) => call.method === "oauth.v2.access");
  assert.equal(exchange?.body.redirect_uri, slackRedirectUri());
  assert.equal(exchange?.body.client_secret, "test-client-secret");

  const connection = await getSlackConnection(p.id);
  assert.equal(connection?.teamId, teamId);
  assert.equal(connection?.status, "active");
  assert.equal(connection?.channelId, null, "no channel until the user picks one");
  assert.ok(!connection?.encryptedBotToken.includes("xoxb"), "token not stored in plain text");
  assert.equal(decryptToken(connection!.encryptedBotToken), `xoxb-${teamId}`);

  // The user clicked Cancel on Slack's screen
  const other = await onboarded();
  const again = createSlackOAuthState(other.id);
  assert.equal(
    await handleSlackOAuthCallback(other.id, { ...again, code: null, error: "access_denied" }),
    "cancelled",
  );
  assert.equal(await getSlackConnection(other.id), undefined);
});

test("2: an invalid OAuth state is rejected before any code exchange", async () => {
  const p = await onboarded();
  const attacker = await onboarded();
  const { state, cookie } = createSlackOAuthState(p.id);
  const code = `team:${team()}`;

  const wrongState = await handleSlackOAuthCallback(p.id, { state: "forged", cookie, code, error: null });
  const noCookie = await handleSlackOAuthCallback(p.id, { state, cookie: undefined, code, error: null });
  // A state started by another account can't complete in this one
  const attackerFlow = createSlackOAuthState(attacker.id);
  const crossUser = await handleSlackOAuthCallback(p.id, { ...attackerFlow, code, error: null });

  assert.deepEqual([wrongState, noCookie, crossUser], ["invalid_state", "invalid_state", "invalid_state"]);
  assert.equal(slack.calls.filter((call) => call.method === "oauth.v2.access").length, 0);
  assert.equal(await getSlackConnection(p.id), undefined);
});

test("3: connect, missing scopes, disconnect (token revoked unless shared)", async () => {
  // Slack granted fewer scopes than Scout asked for
  const partial = await onboarded();
  const flow = createSlackOAuthState(partial.id);
  slack.replies.set("oauth.v2.access", [
    {
      body: {
        ok: true,
        access_token: "xoxb-partial",
        token_type: "bot",
        scope: "chat:write",
        team: { id: team(), name: "Partial" },
      },
    },
  ]);
  assert.equal(
    await handleSlackOAuthCallback(partial.id, { ...flow, code: "team:X", error: null }),
    "missing_scope",
  );
  assert.equal(await getSlackConnection(partial.id), undefined);

  // Two Scout users in one workspace share its bot token
  const { profile: a, teamId } = await slackUser();
  const b = await onboarded();
  await connect(b.id, teamId);

  await disconnectSlack(a.id);
  assert.equal(await getSlackConnection(a.id), undefined);
  const [settings] = await db
    .select()
    .from(s.notificationSettingsTable)
    .where(eq(s.notificationSettingsTable.profileId, a.id));
  assert.equal(settings.slackEnabled, false, "alerts off after disconnect");
  assert.equal(slack.calls.filter((call) => call.method === "auth.revoke").length, 0, "b still uses it");

  await disconnectSlack(b.id);
  const revokes = slack.calls.filter((call) => call.method === "auth.revoke");
  assert.equal(revokes.length, 1);
  assert.equal(revokes[0].token, `xoxb-${teamId}`);
});

test("4: channel selection lists, joins and verifies the channel", async () => {
  const p = await onboarded();
  await connect(p.id);

  const listed = await listSlackChannels(p.id);
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.value.map((channel) => channel.name),
    ["general", "scout-alerts"],
  );

  const missing = await chooseSlackChannel(p.id, "C0MISSING1");
  assert.equal(missing.ok, false);
  assert.equal((await getSlackConnection(p.id))?.channelId, null);

  const chosen = await chooseSlackChannel(p.id, CHANNEL);
  assert.ok(chosen.ok);
  assert.ok(slack.calls.some((call) => call.method === "conversations.join" && call.body.channel === CHANNEL));
  const connection = await getSlackConnection(p.id);
  assert.equal(connection?.channelId, CHANNEL);
  assert.equal(connection?.channelName, "scout-alerts");

  // A revoked token found while listing flags the connection
  slack.replies.set("conversations.list", [{ body: { ok: false, error: "token_revoked" } }]);
  assert.equal((await listSlackChannels(p.id)).ok, false);
  assert.equal((await getSlackConnection(p.id))?.status, "needs_reconnect");
});

test("5: a high-score opportunity is delivered to Slack once, with safe content", async () => {
  const { profile, teamId } = await slackUser();
  const { run, opportunities } = await runWith(profile.id, [{ score: 92 }]);

  const queued = await queueRunNotifications(profile.id, run.id);
  assert.deepEqual(queued, { notified: 1, slackQueued: 1, slackSuppressed: {} });
  const result = await deliver();
  assert.deepEqual(
    result.outcomes.filter((o) => o.profileId === profile.id).map((o) => o.status),
    ["sent"],
  );

  const [message] = sentTo(teamId);
  assert.equal(message.token, `xoxb-${teamId}`);
  assert.equal(message.body.channel, CHANNEL);
  const blocks = JSON.stringify(message.body.blocks);
  assert.ok(blocks.includes("Match score: 92/100"));
  assert.ok(blocks.includes("@founder"));
  assert.ok(blocks.includes("&lt;post 0&gt;"), "post text escaped for Slack");
  assert.ok(blocks.includes(`https://scout.test/opportunities/${opportunities[0].id}`));
  assert.ok(blocks.includes("https://x.com/founder/status/1"));
  assert.ok(!blocks.includes("PRIVATE ANGLE"), "no Brain-derived angle in Slack");

  const [delivery] = await deliveriesOf(profile.id);
  assert.equal(delivery.status, "sent");
  assert.ok(delivery.providerMessageId);
  assert.equal(await countUnreadNotifications(profile.id), 1);
});

test("6: low scores and old posts are not notified", async () => {
  const { profile, teamId } = await slackUser();
  const { run } = await runWith(profile.id, [{ score: 79 }, { score: 95, ageHours: 30 }]);
  const queued = await queueRunNotifications(profile.id, run.id);
  assert.equal(queued.notified, 0);
  await deliver();
  assert.equal(sentTo(teamId).length, 0);
  assert.equal((await notificationsOf(profile.id)).length, 0);

  // The user's own minimum score applies
  await saveNotificationSettings(profile.id, { minScore: 70 });
  assert.equal((await queueRunNotifications(profile.id, run.id)).notified, 1);
});

test("7: no duplicate alerts, even with concurrent workers and repeated queueing", async () => {
  const { profile, teamId } = await slackUser();
  const { run } = await runWith(profile.id, [{ score: 90 }, { score: 88 }, { score: 86 }]);

  await Promise.all([queueRunNotifications(profile.id, run.id), queueRunNotifications(profile.id, run.id)]);
  await queueRunNotifications(profile.id, run.id);
  await Promise.all([deliver(), deliver(), deliver()]);
  await deliver();

  assert.equal((await notificationsOf(profile.id)).length, 3);
  assert.equal((await deliveriesOf(profile.id)).length, 3);
  // This user's workspace only (an earlier test may leave an alert queued)
  const texts = sentTo(teamId).map((call) => JSON.stringify(call.body.blocks));
  assert.equal(texts.length, 3);
  assert.equal(new Set(texts).size, 3);
  assert.equal(await getDailyCount(profile.id, "slack", localDay(new Date(), "UTC")), 3);
});

test("8: the daily limit holds under concurrency; the freshest get the slots", async () => {
  const { profile, teamId } = await slackUser({ maxPerDay: 5 });
  // Two runs queued in parallel, 8 strong opportunities in total
  const first = await runWith(profile.id, [
    { score: 90, ageHours: 5 },
    { score: 90, ageHours: 1 },
    { score: 90, ageHours: 6 },
    { score: 90, ageHours: 2 },
  ]);
  const second = await runWith(profile.id, [
    { score: 90, ageHours: 3 },
    { score: 90, ageHours: 7 },
    { score: 90, ageHours: 0.5 },
    { score: 90, ageHours: 8 },
  ]);
  const [a, b] = await Promise.all([
    queueRunNotifications(profile.id, first.run.id),
    queueRunNotifications(profile.id, second.run.id),
  ]);
  assert.equal(a.slackQueued + b.slackQueued, 5);
  assert.equal((a.slackSuppressed.daily_limit ?? 0) + (b.slackSuppressed.daily_limit ?? 0), 3);
  assert.equal(a.notified + b.notified, 8, "every one is still in the bell");

  await deliver();
  assert.equal(sentTo(teamId).length, 5);
  assert.equal(await getDailyCount(profile.id, "slack", localDay(new Date(), "UTC")), 5);
  // Within each run the freshest posts were queued first
  const pending = await db
    .select({ status: s.notificationDeliveriesTable.status, postedAt: s.opportunitiesTable.postedAt })
    .from(s.notificationDeliveriesTable)
    .innerJoin(s.notificationsTable, eq(s.notificationsTable.id, s.notificationDeliveriesTable.notificationId))
    .innerJoin(s.opportunitiesTable, eq(s.opportunitiesTable.id, s.notificationsTable.opportunityId))
    .where(eq(s.notificationDeliveriesTable.profileId, profile.id));
  const age = (row: (typeof pending)[number]) => (Date.now() - row.postedAt!.getTime()) / 3600_000;
  const sent = pending.filter((row) => row.status === "sent").map(age);
  const suppressed = pending.filter((row) => row.status === "suppressed").map(age);
  assert.ok(Math.max(...sent) < 8 && Math.min(...suppressed) > 4.5, JSON.stringify({ sent, suppressed }));

  // A later run the same day: limit already used up
  const third = await runWith(profile.id, [{ score: 99 }]);
  const late = await queueRunNotifications(profile.id, third.run.id);
  assert.deepEqual(late.slackSuppressed, { daily_limit: 1 });
});

test("9: quiet hours keep Slack silent but the bell still gets it", async () => {
  const hour = new Date().getUTCHours();
  const { profile, teamId } = await slackUser({ quietHoursStart: hour, quietHoursEnd: (hour + 1) % 24 });
  const { run } = await runWith(profile.id, [{ score: 95 }]);
  const queued = await queueRunNotifications(profile.id, run.id);
  assert.deepEqual(queued.slackSuppressed, { quiet_hours: 1 });
  await deliver();
  assert.equal(sentTo(teamId).length, 0);
  assert.equal(await countUnreadNotifications(profile.id), 1);
  assert.equal(await getDailyCount(profile.id, "slack", localDay(new Date(), "UTC")), 0, "no slot used");

  // Window rules: spans midnight, timezones, unset
  const at = (iso: string) => new Date(iso);
  const night = { quietHoursStart: 22, quietHoursEnd: 7, timezone: "UTC" };
  assert.equal(isQuietHours(at("2026-11-12T23:30:00Z"), night), true);
  assert.equal(isQuietHours(at("2026-11-12T06:59:00Z"), night), true);
  assert.equal(isQuietHours(at("2026-11-12T07:00:00Z"), night), false);
  assert.equal(isQuietHours(at("2026-11-12T21:30:00Z"), { ...night, timezone: "Europe/Belgrade" }), true);
  assert.equal(isQuietHours(at("2026-11-12T03:00:00Z"), { ...night, quietHoursStart: null }), false);
});

test("10: Slack errors and rate limits", async () => {
  // 429: retried after exactly Retry-After, then sent
  const limited = await slackUser();
  const r1 = await runWith(limited.profile.id, [{ score: 90 }]);
  await queueRunNotifications(limited.profile.id, r1.run.id);
  slack.replies.set("chat.postMessage", [{ status: 429, retryAfter: 42 }]);
  const own = (result: Awaited<ReturnType<typeof deliver>>, profileId: string) =>
    result.outcomes.filter((o) => o.profileId === profileId);
  const first = await deliver();
  assert.deepEqual(own(first, limited.profile.id).map((o) => [o.status, o.reason]), [["retry", "ratelimited"]]);
  const [waiting] = await deliveriesOf(limited.profile.id);
  const waitSeconds = (waiting.runAfter.getTime() - Date.now()) / 1000;
  assert.equal(waiting.status, "pending");
  assert.ok(waitSeconds > 35 && waitSeconds <= 43, `retry in ${waitSeconds} s`);
  assert.equal(own(await deliver(), limited.profile.id).length, 0, "not before Retry-After");
  await dueNow(limited.profile.id);
  assert.deepEqual(own(await deliver(), limited.profile.id).map((o) => o.status), ["sent"]);

  // Revoked token: failed, connection flagged, daily slot given back
  const revoked = await slackUser();
  const r2 = await runWith(revoked.profile.id, [{ score: 90 }]);
  await queueRunNotifications(revoked.profile.id, r2.run.id);
  slack.replies.set("chat.postMessage", [{ body: { ok: false, error: "token_revoked" } }]);
  await deliver();
  const [dead] = await deliveriesOf(revoked.profile.id);
  assert.equal(dead.status, "failed");
  assert.equal(dead.reason, "token_revoked");
  assert.equal((await getSlackConnection(revoked.profile.id))?.status, "needs_reconnect");
  assert.equal(await getDailyCount(revoked.profile.id, "slack", dead.day), 0);
  // Nothing more is queued for a broken connection
  const r2b = await runWith(revoked.profile.id, [{ score: 90 }]);
  assert.equal((await queueRunNotifications(revoked.profile.id, r2b.run.id)).slackQueued, 0);

  // Bot removed from the channel
  const kicked = await slackUser();
  const r3 = await runWith(kicked.profile.id, [{ score: 90 }]);
  await queueRunNotifications(kicked.profile.id, r3.run.id);
  slack.replies.set("chat.postMessage", [{ body: { ok: false, error: "not_in_channel" } }]);
  await deliver();
  assert.equal((await getSlackConnection(kicked.profile.id))?.status, "channel_unavailable");

  // Slack down: bounded retries, then failed
  const flaky = await slackUser();
  const r4 = await runWith(flaky.profile.id, [{ score: 90 }]);
  await queueRunNotifications(flaky.profile.id, r4.run.id);
  slack.replies.set("chat.postMessage", Array.from({ length: 10 }, () => ({ status: 503 })));
  for (let i = 0; i < 6; i++) {
    await dueNow(flaky.profile.id);
    await deliver();
  }
  const [gaveUp] = await deliveriesOf(flaky.profile.id);
  assert.equal(gaveUp.status, "failed");
  assert.equal(gaveUp.attempts, 4);
  assert.equal(sentTo(flaky.teamId).length, 4);
});

test("11: users are isolated: own workspace, own channel, own notifications", async () => {
  const a = await slackUser();
  const b = await slackUser();
  const runA = await runWith(a.profile.id, [{ score: 90 }]);
  const runB = await runWith(b.profile.id, [{ score: 91 }]);
  await queueRunNotifications(a.profile.id, runA.run.id);
  await queueRunNotifications(b.profile.id, runB.run.id);
  // Queueing a run for the wrong profile finds nothing
  assert.equal((await queueRunNotifications(a.profile.id, runB.run.id)).notified, 0);
  await deliver();

  const byToken = sentTo;
  assert.equal(byToken(a.teamId).length, 1);
  assert.equal(byToken(b.teamId).length, 1);
  assert.ok(JSON.stringify(byToken(a.teamId)[0].body.blocks).includes(runA.opportunities[0].id));
  assert.ok(JSON.stringify(byToken(b.teamId)[0].body.blocks).includes(runB.opportunities[0].id));

  // A's notification can't be marked read by B, and B can't open A's opportunity
  const [notificationA] = await notificationsOf(a.profile.id);
  assert.equal(await markNotificationsRead(b.profile.id, notificationA.id), 0);
  assert.equal(await countUnreadNotifications(a.profile.id), 1);
  assert.equal(await getOpportunityForProfile(b.profile.id, runA.opportunities[0].id), undefined);
  assert.equal(await markNotificationsRead(a.profile.id, notificationA.id), 1);
  assert.equal(await countUnreadNotifications(a.profile.id), 0);
});

test("12: an automatic scan notifies; a Slack outage never fails the scan", async () => {
  const { profile, teamId } = await slackUser();
  await db
    .update(s.profilesTable)
    .set({ autoScanEnabled: true, nextScanAt: sql`now() - interval '1 minute'` })
    .where(eq(s.profilesTable.id, profile.id));
  const user = `n${Date.now()}`;
  addTweets(user, 2);
  await watch(profile.id, [user]);

  const result = await runSchedulerTick({ cleanup: false });
  const mine = result.outcomes.filter((o) => o.profileId === profile.id);
  assert.deepEqual(mine.map((o) => [o.status, o.notified]), [["completed", 2]]);
  assert.deepEqual(
    result.deliveries?.outcomes.filter((o) => o.profileId === profile.id).map((o) => o.status),
    ["sent", "sent"],
  );
  assert.equal(sentTo(teamId).length, 2);

  // Slack fails on every call: the scan still completes, the alert waits
  const other = await slackUser();
  await db
    .update(s.profilesTable)
    .set({ autoScanEnabled: true, nextScanAt: sql`now() - interval '1 minute'` })
    .where(eq(s.profilesTable.id, other.profile.id));
  const user2 = `n${Date.now()}b`;
  addTweets(user2, 1);
  await watch(other.profile.id, [user2]);
  slack.replies.set("chat.postMessage", Array.from({ length: 5 }, () => ({ status: 500 })));
  const second = await runSchedulerTick({ cleanup: false });
  assert.deepEqual(
    second.outcomes.filter((o) => o.profileId === other.profile.id).map((o) => o.status),
    ["completed"],
  );
  const [waiting] = await deliveriesOf(other.profile.id);
  assert.equal(waiting.status, "pending", "retried on a later tick");
});

test("13: notifications make no OpenAI or X calls", async () => {
  const { profile, teamId } = await slackUser();
  const { run } = await runWith(profile.id, [{ score: 95 }, { score: 85 }, { score: 40 }]);
  const before = { ai: ai.calls.length, x: x.calls.length };
  await queueRunNotifications(profile.id, run.id);
  await deliver();
  assert.equal(sentTo(teamId).length, 2);
  assert.deepEqual({ ai: ai.calls.length, x: x.calls.length }, before);
});

test("14: a test notification is sent at once, labeled, outside the alert pipeline", async () => {
  // Not connected / no channel yet: nothing is sent
  const fresh = await onboarded();
  assert.equal((await sendSlackTestMessage(fresh.id)).ok, false);
  await connect(fresh.id);
  const noChannel = await sendSlackTestMessage(fresh.id);
  assert.equal(noChannel.ok, false);
  assert.equal(slack.messages().length, 0);

  const { profile, teamId } = await slackUser();
  const before = { ai: ai.calls.length, x: x.calls.length };
  const sent = await sendSlackTestMessage(profile.id);
  assert.ok(sent.ok);
  assert.equal(sent.value.channelName, "scout-alerts");
  const [message] = sentTo(teamId);
  assert.equal(message.body.channel, CHANNEL);
  const blocks = JSON.stringify(message.body.blocks);
  assert.ok(blocks.includes("Scout test notification"));
  assert.ok(blocks.includes("This is a test, not an opportunity."));
  assert.ok(blocks.includes("https://scout.test/account/settings"));
  // No scan, no credits, no delivery, no daily-limit slot, nothing in the bell
  assert.deepEqual({ ai: ai.calls.length, x: x.calls.length }, before);
  assert.equal((await deliveriesOf(profile.id)).length, 0);
  assert.equal((await notificationsOf(profile.id)).length, 0);
  assert.equal(await getDailyCount(profile.id, "slack", localDay(new Date(), "UTC")), 0);
  assert.equal(
    (await db.select().from(s.scoutRunsTable).where(eq(s.scoutRunsTable.profileId, profile.id))).length,
    0,
  );

  // Success only when Slack says ok: rate limit, outage and removed bot all fail
  slack.replies.set("chat.postMessage", [{ status: 429, retryAfter: 30 }]);
  assert.equal((await sendSlackTestMessage(profile.id)).ok, false);
  slack.replies.set("chat.postMessage", [{ status: 503 }]);
  assert.equal((await sendSlackTestMessage(profile.id)).ok, false);
  assert.equal((await getSlackConnection(profile.id))?.status, "active", "temporary errors don't flag it");
  slack.replies.set("chat.postMessage", [{ body: { ok: false, error: "not_in_channel" } }]);
  const kicked = await sendSlackTestMessage(profile.id);
  assert.equal(kicked.ok, false);
  assert.equal((await getSlackConnection(profile.id))?.status, "channel_unavailable");

  // Revoked token: flagged for reconnect
  const revoked = await slackUser();
  slack.replies.set("chat.postMessage", [{ body: { ok: false, error: "token_revoked" } }]);
  assert.equal((await sendSlackTestMessage(revoked.profile.id)).ok, false);
  assert.equal((await getSlackConnection(revoked.profile.id))?.status, "needs_reconnect");
});
