// X OAuth 2.0 (PKCE) for Growth Intelligence: the flow's state and PKCE,
// ownership from /2/users/me, encrypted tokens, refresh-token rotation,
// private metrics only inside X's 30-day window, plan budgets and spacing,
// one collection at a time, automatic collection (off by default), and
// disconnecting. X is mocked (tests/helpers/mocks.ts); nothing real is called.
import "./setup/env";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { eq, inArray } from "drizzle-orm";

import db from "@/db";
import { getSnapshotsForProfile } from "@/db/queries/growth";
import { getXConnection } from "@/db/queries/xConnections";
import * as s from "@/db/schema";
import { decryptToken } from "@/lib/crypto/tokens";
import { createXOAuthStart, readXOAuthCookie } from "@/lib/x/oauth";
import { getUsageBudget } from "@/services/billing/budget";
import { refreshGrowthData, runDueGrowthCollections } from "@/services/growth/collect";
import { buildGrowthReport } from "@/services/growth/report";
import { disconnectX, handleXOAuthCallback } from "@/services/x/oauthConnection";

import { cleanup, getProfile, newProfile, rememberXUsage, setOverrides } from "./helpers/db";
import { installMocks, nextId, x, xOAuth } from "./helpers/mocks";

const DAY = 86_400_000;

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);
beforeEach(() => {
  process.env.X_OAUTH_ENABLED = "true";
  process.env.X_ANALYTICS_AUTO_ENABLED = "false";
  delete process.env.X_ANALYTICS_AUTO_MAX_PER_DAY;
  x.calls.length = 0;
  xOAuth.tokenCalls.length = 0;
  xOAuth.revoked.length = 0;
  xOAuth.userTokenCalls.length = 0;
});

/** A Scout profile whose X handle is `handle`, an X user that exists, on `plan` */
async function xUser(plan: s.Profile["plan"] = "free", { handle = `u${nextId().slice(-8)}`, withHandle = true } = {}) {
  const userId = nextId();
  x.users.set(handle.toLowerCase(), userId);
  const p = await newProfile();
  await db
    .update(s.profilesTable)
    .set({ plan, xHandle: withHandle ? handle : null, onboardingCompleted: true })
    .where(eq(s.profilesTable.id, p.id));
  return { profile: await getProfile(p.id), userId, handle };
}

async function connect(profile: s.Profile, code: string, { error = null as string | null } = {}) {
  const { url, cookie } = createXOAuthStart(profile.id);
  const state = new URL(url).searchParams.get("state");
  return handleXOAuthCallback(profile, { state, code, error, cookie });
}

/** Own posts on the mocked timeline: `recent` from the last days, `old` from 40+ days ago */
function ownPosts(userId: string, { recent = 3, old = 0 } = {}): string[] {
  const list = x.timelines.get(userId) ?? [];
  const ids: string[] = [];
  for (let i = 0; i < old; i++) {
    const id = nextId();
    list.push({ id, text: `Old post ${id}`, created_at: new Date(Date.now() - (40 + i) * DAY).toISOString() });
  }
  for (let i = 0; i < recent; i++) {
    const id = nextId();
    ids.push(id);
    list.push({ id, text: `Recent post ${id}`, created_at: new Date(Date.now() - (i + 1) * DAY).toISOString() });
  }
  x.timelines.set(userId, list);
  return ids;
}

test("authorize URL: S256 PKCE, read-only scopes, exact callback; flow cookie encrypted and bound to the profile", async () => {
  const { profile } = await xUser();
  const { url, cookie } = createXOAuthStart(profile.id);
  const params = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("scope"), "tweet.read users.read offline.access");
  assert.equal(params.get("redirect_uri"), "https://scout.test/api/x/oauth/callback");
  assert.equal(params.get("code_challenge_method"), "S256");

  const state = params.get("state")!;
  assert.ok(!cookie.includes(state), "the cookie never holds the state in the clear");
  const flow = readXOAuthCookie(state, cookie, profile.id);
  assert.ok(flow);
  assert.ok(!cookie.includes(flow.verifier), "nor the verifier");
  assert.equal(createHash("sha256").update(flow.verifier).digest("base64url"), params.get("code_challenge"));

  assert.equal(readXOAuthCookie(state, cookie, "another-profile"), null, "bound to the profile that started");
  assert.equal(readXOAuthCookie(`${state}x`, cookie, profile.id), null, "state must match");
  assert.equal(readXOAuthCookie(state, cookie, profile.id, Date.now() + 11 * 60_000), null, "expires after 10 minutes");
  assert.equal(readXOAuthCookie(state, `${cookie.slice(0, -2)}AA`, profile.id), null, "tampered cookie fails");
});

test("callback: bad state, cancel and a missing scope connect nothing; granted tokens are revoked", async () => {
  const { profile, userId } = await xUser();
  assert.equal(await handleXOAuthCallback(profile, { state: "forged", code: `user:${userId}`, error: null, cookie: undefined }), "invalid_state");
  assert.equal(await connect(profile, "", { error: "access_denied" }), "cancelled");
  assert.equal(xOAuth.tokenCalls.length, 0, "no code is exchanged without a valid state, or after cancel");

  assert.equal(await connect(profile, `user:${userId}:noscope`), "missing_scope");
  assert.equal(xOAuth.tokenCalls[0].grant, "authorization_code");
  assert.match(xOAuth.tokenCalls[0].auth ?? "", /^Basic /, "confidential client: HTTP Basic");
  assert.ok(xOAuth.tokenCalls[0].body.code_verifier, "PKCE verifier sent");
  assert.ok(xOAuth.revoked.length >= 1, "tokens granted without the scopes are revoked");
  assert.equal(await getXConnection(profile.id), undefined);

  process.env.X_OAUTH_ENABLED = "false";
  assert.equal(await connect(profile, `user:${userId}`), "not_configured", "off: nothing happens");
});

test("connect: the account comes from /2/users/me, tokens are encrypted, other accounts are refused", async () => {
  const alice = await xUser("free");
  assert.equal(await connect(alice.profile, `user:${alice.userId}`), "connected");
  assert.ok(x.calls.includes("/2/users/me"), "ownership checked with the user's own token");

  const row = (await getXConnection(alice.profile.id))!;
  assert.equal(row.xUserId, alice.userId);
  assert.equal(row.status, "active");
  assert.ok(!row.encryptedAccessToken.includes("ua-") && !row.encryptedRefreshToken!.includes("ur-"), "never stored in the clear");
  assert.match(decryptToken(row.encryptedAccessToken), /^ua-/);
  assert.equal(row.nextCollectionAt, null, "Free: manual refresh only");
  const [snapshot] = await getSnapshotsForProfile(alice.profile.id);
  assert.equal(snapshot.followers, 1234, "follower count from the same ownership check");
  assert.equal(snapshot.xPostReads, 0);

  // Someone whose Scout profile is about another X account
  const bob = await xUser("free");
  assert.equal(await connect(bob.profile, `user:${alice.userId}`), "handle_mismatch");
  // Someone without a handle trying to take an account that is already connected
  const carol = await xUser("free", { withHandle: false });
  assert.equal(await connect(carol.profile, `user:${alice.userId}`), "in_use");
  assert.equal(await getXConnection(bob.profile.id), undefined);
  assert.equal(await getXConnection(carol.profile.id), undefined);
  assert.equal(xOAuth.revoked.length, 4, "both refused grants are revoked (access + refresh)");

  // A profile without a handle takes the verified one
  const dave = await xUser("starter", { withHandle: false });
  assert.equal(await connect(dave.profile, `user:${dave.userId}`), "connected");
  assert.equal((await getProfile(dave.profile.id)).xHandle, dave.handle);
  assert.ok((await getXConnection(dave.profile.id))!.nextCollectionAt, "Starter: automatic collection planned");
});

test("refresh: private metrics only for posts inside X's 30-day window, from the plan's X reads, once a day", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  const recent = ownPosts(userId, { recent: 3, old: 2 });

  const before = (await getUsageBudget(profile)).used.xPostReads;
  const result = await refreshGrowthData(profile);
  assert.ok(result.ok, result.message);
  assert.match(result.message, /3 with private metrics/);
  assert.equal((await getUsageBudget(profile)).used.xPostReads, before + 3, "only what X returned is counted");
  assert.ok(!x.calls.some((path) => path.startsWith("/2/users/by/username")), "the user token replaces the public lookup");

  const report = await buildGrowthReport(profile, { range: 30, tz: "UTC" });
  assert.ok("privateMetrics" in report);
  assert.equal(report.xConnection?.status, "active");
  assert.equal(report.privateMetrics!.covered, 3);
  assert.equal(report.privateMetrics!.profileClicks, 15);
  assert.equal(report.privateMetrics!.linkClicks, 9);
  assert.equal(report.privateMetrics!.xEngagements, 120);
  assert.deepEqual(new Set(report.posts!.map((post) => post.platformPostId)), new Set(recent), "old posts never requested");

  const again = await refreshGrowthData(profile);
  assert.equal(again.ok, false);
  assert.match(again.message, /again in about/);
  assert.equal(x.calls.filter((path) => path.endsWith("/tweets")).length, 1, "no second read");
});

test("refresh: two at once read X once", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  ownPosts(userId, { recent: 2 });
  x.calls.length = 0;
  x.delayMs = 50;
  try {
    const results = await Promise.all([refreshGrowthData(profile), refreshGrowthData(profile)]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.match(results.find((r) => !r.ok)!.message, /already running/);
  } finally {
    x.delayMs = 0;
  }
  assert.equal(x.calls.filter((path) => path.endsWith("/tweets")).length, 1);
});

test("not connected: private metrics are unavailable (null), never zero", async () => {
  const { profile, userId } = await xUser("free");
  ownPosts(userId, { recent: 2 });
  // Public refresh: X OAuth is on, but this user never connected
  assert.ok((await refreshGrowthData(profile)).ok);
  assert.equal(xOAuth.userTokenCalls.length, 0);
  const report = await buildGrowthReport(profile, { range: 30, tz: "UTC" });
  assert.equal(report.xConnection, null);
  assert.equal(report.privateMetrics!.covered, 0);
  assert.equal(report.privateMetrics!.total, 2);
  assert.equal(report.privateMetrics!.profileClicks, null);
  assert.equal(report.privateMetrics!.linkClicks, null);
  assert.ok(report.posts!.every((post) => post.profileClicks === null && post.linkClicks === null));
});

test("tokens: an expired access token is refreshed and the rotated refresh token stored; a dead grant asks to reconnect", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  ownPosts(userId, { recent: 1 });
  const first = (await getXConnection(profile.id))!;
  await db.update(s.xConnectionsTable).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(s.xConnectionsTable.id, first.id));

  assert.ok((await refreshGrowthData(profile)).ok);
  assert.equal(xOAuth.tokenCalls.at(-1)!.grant, "refresh_token");
  const second = (await getXConnection(profile.id))!;
  assert.notEqual(decryptToken(second.encryptedRefreshToken!), decryptToken(first.encryptedRefreshToken!), "rotated");
  assert.ok(second.accessTokenExpiresAt > new Date());

  // The user revoked Scout on X: the refresh token no longer works
  const later = new Date(Date.now() + 21 * 3_600_000);
  xOAuth.refreshTokens.clear();
  await db.update(s.xConnectionsTable).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(s.xConnectionsTable.id, first.id));
  const result = await refreshGrowthData(profile, later);
  assert.equal(result.ok, false);
  assert.match(result.message, /Reconnect X/);
  assert.equal((await getXConnection(profile.id))!.status, "needs_reconnect");
  assert.match((await refreshGrowthData(profile, later)).message, /Reconnect X/, "no X call while it needs reconnecting");
});

test("tokens: a 401 from X (access revoked) flags the connection", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  xOAuth.accessTokens.clear();
  const result = await refreshGrowthData(profile);
  assert.equal(result.ok, false);
  assert.equal((await getXConnection(profile.id))!.status, "needs_reconnect");
});

test("automatic collection: off by default; Starter/Pro only; global daily cap; leaves reads for scans", async () => {
  const free = await xUser("free");
  const starter = await xUser("starter");
  const pro = await xUser("pro");
  const poor = await xUser("pro");
  for (const u of [free, starter, pro, poor]) {
    assert.equal(await connect(u.profile, `user:${u.userId}`), "connected");
    ownPosts(u.userId, { recent: 2 });
  }
  const due = (id: string, minutesAgo: number) =>
    db.update(s.xConnectionsTable).set({ nextCollectionAt: new Date(Date.now() - minutesAgo * 60_000) }).where(eq(s.xConnectionsTable.profileId, id));
  await due(free.profile.id, 30);
  await due(starter.profile.id, 20);
  await due(poor.profile.id, 15);
  await due(pro.profile.id, 10);
  await setOverrides(poor.profile.id, { monthlyXPostReads: 30 });

  assert.deepEqual(await runDueGrowthCollections(), [], "X_ANALYTICS_AUTO_ENABLED is off");
  process.env.X_ANALYTICS_AUTO_ENABLED = "true";
  assert.deepEqual(await runDueGrowthCollections(), [], "no daily cap set: still nothing");

  process.env.X_ANALYTICS_AUTO_MAX_PER_DAY = "3";
  const outcomes = await runDueGrowthCollections();
  const byProfile = new Map(outcomes.map((o) => [o.profileId, o]));
  assert.equal(byProfile.has(free.profile.id), false, "Free is never collected automatically");
  assert.equal(byProfile.get(starter.profile.id)?.status, "collected");
  assert.equal(byProfile.get(poor.profile.id)?.status, "skipped", "would leave scans without X reads");
  assert.equal(byProfile.get(pro.profile.id)?.status, "collected");

  const poorRow = (await getXConnection(poor.profile.id))!;
  assert.ok(poorRow.nextCollectionAt! > new Date(Date.now() + 20 * 3_600_000), "skipped: tried again in a day, not every tick");
  const starterRow = (await getXConnection(starter.profile.id))!;
  assert.ok(starterRow.nextCollectionAt! > new Date(Date.now() + 6 * DAY), "Starter: weekly");

  // Cap: 3 per day, 2 collected so far (the skip didn't start a collection)
  await due(starter.profile.id, 1);
  await due(pro.profile.id, 1);
  await db
    .update(s.accountMetricSnapshotsTable)
    .set({ refreshedAt: new Date(Date.now() - 2 * DAY) })
    .where(inArray(s.accountMetricSnapshotsTable.profileId, [starter.profile.id, pro.profile.id]));
  const second = await runDueGrowthCollections();
  assert.equal(second.length, 1, "only one more fits under today's cap");
});

test("manual refresh moves the automatic one: never both", async () => {
  process.env.X_ANALYTICS_AUTO_ENABLED = "true";
  process.env.X_ANALYTICS_AUTO_MAX_PER_DAY = "10";
  const u = await xUser("pro");
  await connect(u.profile, `user:${u.userId}`);
  ownPosts(u.userId, { recent: 1 });
  assert.ok((await refreshGrowthData(u.profile)).ok);
  const row = (await getXConnection(u.profile.id))!;
  assert.ok(row.nextCollectionAt! > new Date(Date.now() + 2 * DAY), "Pro: next automatic in 3 days");
  assert.ok(!(await runDueGrowthCollections()).some((o) => o.profileId === u.profile.id));
});

test("disconnect: revokes at X, deletes tokens; stored history kept or deleted on request", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  ownPosts(userId, { recent: 2 });
  assert.ok((await refreshGrowthData(profile)).ok);
  const tokens = (await getXConnection(profile.id))!;

  await disconnectX(profile.id);
  assert.ok(xOAuth.revoked.includes(decryptToken(tokens.encryptedRefreshToken!)));
  assert.ok(xOAuth.revoked.includes(decryptToken(tokens.encryptedAccessToken)));
  assert.equal(await getXConnection(profile.id), undefined);
  const kept = await buildGrowthReport(profile, { range: 30, tz: "UTC" });
  assert.ok("privateMetrics" in kept);
  assert.equal(kept.xConnection, null);
  assert.equal(kept.privateMetrics!.covered, 2, "readings already taken stay, labeled as such");

  await disconnectX(profile.id, { deleteHistory: true });
  const gone = await buildGrowthReport(profile, { range: 30, tz: "UTC" });
  assert.ok("privateMetrics" in gone);
  assert.equal(gone.privateMetrics!.covered, 0);
  assert.equal(gone.privateMetrics!.profileClicks, null);
  const rows = await db.select().from(s.postMetricSnapshotsTable).where(eq(s.postMetricSnapshotsTable.profileId, profile.id));
  assert.equal(rows.length, 0);
});

test("feature off: a connected profile falls back to the public refresh and the new tables are not read", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  ownPosts(userId, { recent: 2 });
  process.env.X_OAUTH_ENABLED = "false";
  xOAuth.userTokenCalls.length = 0;
  const result = await refreshGrowthData(profile);
  assert.ok(result.ok, result.message);
  assert.equal(xOAuth.userTokenCalls.length, 0, "no user-token call");
  assert.ok(x.calls.some((path) => path.startsWith("/2/users/by/username")), "public path");
  const report = await buildGrowthReport(profile, { range: 30, tz: "UTC" });
  assert.equal(report.xConnection, null);
});
