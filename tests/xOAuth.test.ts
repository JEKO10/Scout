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
import { buildEvidence } from "@/lib/strategy/plan";
import { createXOAuthStart, readXOAuthCookie } from "@/lib/x/oauth";
import { canUse, X_PUBLISH_SCOPES, X_READ_SCOPES } from "@/lib/x/permissions";
import { getUsageBudget } from "@/services/billing/budget";
import { collectConnectedGrowthData, refreshGrowthData, runDueGrowthCollections } from "@/services/growth/collect";
import { buildGrowthReport } from "@/services/growth/report";
import { disconnectX, getXConnectionOverview, handleXOAuthCallback } from "@/services/x/oauthConnection";

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
  return (await handleXOAuthCallback(profile, { state, code, error, cookie })).status;
}

/** Posts Scout already holds from an X account of this profile (e.g. a public sync) */
async function storedAccount(profileId: string, handle: string, platformUserId: string, posts = 1) {
  const [account] = await db.insert(s.socialAccountsTable).values({ profileId, platform: "x", platformUserId, handle }).returning();
  for (let i = 0; i < posts; i++) {
    await db.insert(s.postsTable).values({ socialAccountId: account.id, platformPostId: nextId(), content: "A stored post", publishedAt: new Date() });
  }
  return account;
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
  assert.equal((await handleXOAuthCallback(profile, { state: "forged", code: `user:${userId}`, error: null, cookie: undefined })).status, "invalid_state");
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

  // Someone whose Scout profile already analyzes another X account
  const bob = await xUser("free");
  await storedAccount(bob.profile.id, bob.handle, bob.userId);
  const refused = await (async () => {
    const { url, cookie } = createXOAuthStart(bob.profile.id);
    return handleXOAuthCallback(bob.profile, { state: new URL(url).searchParams.get("state"), code: `user:${alice.userId}`, error: null, cookie });
  })();
  assert.deepEqual(refused, { status: "handle_mismatch", authorizedHandle: alice.handle }, "names the account they authorized");
  assert.equal((await getProfile(bob.profile.id)).xHandle, bob.handle, "the profile isn't changed");
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

test("another account: the same X account renamed, or a handle with no data, connects and takes the verified handle", async () => {
  // Renamed on X: Scout holds posts under the old handle, but the X user ID is the same
  const renamed = await xUser("free", { handle: `old${nextId().slice(-6)}` });
  await storedAccount(renamed.profile.id, renamed.handle, renamed.userId, 2);
  const newHandle = `new${nextId().slice(-6)}`;
  x.users.delete(renamed.handle.toLowerCase());
  x.users.set(newHandle.toLowerCase(), renamed.userId);
  assert.equal(await connect(renamed.profile, `user:${renamed.userId}`), "connected");
  assert.equal((await getProfile(renamed.profile.id)).xHandle, newHandle);
  const accounts = await db.select().from(s.socialAccountsTable).where(eq(s.socialAccountsTable.profileId, renamed.profile.id));
  assert.equal(accounts.length, 1, "the same account row, renamed: no duplicate");
  assert.equal(accounts[0].handle, newHandle);

  // A handle typed in onboarding, never synced: nothing to mix, so the verified account replaces it
  const typo = await xUser("free");
  const real = await xUser("free", { withHandle: false });
  await db.delete(s.profilesTable).where(eq(s.profilesTable.id, real.profile.id));
  assert.equal(await connect(typo.profile, `user:${real.userId}`), "connected");
  assert.equal((await getProfile(typo.profile.id)).xHandle, real.handle);
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

// ---- Day 37 --------------------------------------------------------------------------

test("callback replay: the same callback a second time exchanges nothing and changes nothing", async () => {
  const { profile, userId } = await xUser("free");
  const { url, cookie } = createXOAuthStart(profile.id);
  const callback = { state: new URL(url).searchParams.get("state"), code: `user:${userId}`, error: null, cookie };
  assert.equal((await handleXOAuthCallback(profile, callback)).status, "connected");
  const before = (await getXConnection(profile.id))!;
  assert.equal((await handleXOAuthCallback(await getProfile(profile.id), callback)).status, "failed", "X refuses a used code");
  const after = (await getXConnection(profile.id))!;
  assert.equal(after.encryptedAccessToken, before.encryptedAccessToken, "tokens untouched");
});

test("initial import: once, sized by the plan and the X reads left, deduplicated with later refreshes", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  ownPosts(userId, { recent: 28, old: 2 });
  await setOverrides(profile.id, { maxInitialImportPosts: 25 });
  const p = await getProfile(profile.id);
  const reads = (await getUsageBudget(p)).used.xPostReads;

  const imported = await collectConnectedGrowthData(p, "import");
  assert.ok(imported.ok, imported.message);
  assert.match(imported.message, /^Imported 25 posts/);
  assert.equal((await getUsageBudget(p)).used.xPostReads, reads + 25, "counted in the plan's X reads");
  assert.ok((await getXConnection(profile.id))!.initialImportAt);
  const again = await collectConnectedGrowthData(p, "import");
  assert.equal(again.ok, false);
  assert.match(again.message, /already imported/);

  // A later refresh reads the newest posts again: upserted, never duplicated
  assert.ok((await refreshGrowthData(p, new Date(Date.now() + 21 * 3_600_000))).ok);
  const stored = await db
    .select()
    .from(s.postsTable)
    .innerJoin(s.socialAccountsTable, eq(s.socialAccountsTable.id, s.postsTable.socialAccountId))
    .where(eq(s.socialAccountsTable.profileId, profile.id));
  assert.equal(new Set(stored.map((r) => r.posts.platformPostId)).size, stored.length);
  assert.equal(stored.length, 25);
});

test("initial import: partial when the plan has fewer X reads left; none under 5, without calling X", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  ownPosts(userId, { recent: 20 });
  await setOverrides(profile.id, { maxInitialImportPosts: 25, monthlyXPostReads: 12 });
  const partial = await collectConnectedGrowthData(await getProfile(profile.id), "import");
  assert.ok(partial.ok, partial.message);
  assert.match(partial.message, /^Imported 12 posts/);

  const other = await xUser("free");
  await connect(other.profile, `user:${other.userId}`);
  await setOverrides(other.profile.id, { monthlyXPostReads: 3 });
  x.calls.length = 0;
  const refused = await collectConnectedGrowthData(await getProfile(other.profile.id), "import");
  assert.equal(refused.ok, false);
  assert.equal(x.calls.length, 0);
});

test("partial responses: posts without private metrics stay null; Growth counts them as missing", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  const [withMetrics, without] = ownPosts(userId, { recent: 2 });
  xOAuth.noPrivate.add(without);
  assert.ok((await refreshGrowthData(profile)).ok);
  const report = await buildGrowthReport(profile, { range: 30, tz: "UTC" });
  assert.equal(report.privateMetrics!.covered, 1);
  assert.equal(report.privateMetrics!.total, 2);
  assert.equal(report.posts!.find((p) => p.platformPostId === without)!.profileClicks, null, "never zero");
  assert.ok(report.posts!.find((p) => p.platformPostId === withMetrics)!.profileClicks! > 0);
});

test("sync status: a failed sync shows as failed with a reason; a successful one clears it", async () => {
  const { profile, userId } = await xUser("free");
  await connect(profile, `user:${userId}`);
  ownPosts(userId, { recent: 2 });
  x.failures.set(userId, ["500", "500"]);
  assert.equal((await refreshGrowthData(profile)).ok, false);
  let overview = await getXConnectionOverview(await getProfile(profile.id));
  assert.equal(overview.connection!.state, "sync_failed");
  assert.match(overview.connection!.lastError ?? "", /^Sync failed: X answered 500/);
  assert.deepEqual(overview.connection!.scopes, ["tweet.read", "users.read", "offline.access"]);

  assert.ok((await refreshGrowthData(profile, new Date(Date.now() + 21 * 3_600_000))).ok);
  overview = await getXConnectionOverview(await getProfile(profile.id));
  assert.equal(overview.connection!.state, "connected");
  assert.equal(overview.connection!.lastError, null);
  assert.equal(overview.connection!.displayName, `Name ${profile.xHandle}`);
});

test("publishing boundary: read-only scopes, no publishing capability, no write calls to X", () => {
  assert.ok(!X_READ_SCOPES.some((scope) => scope.includes("write")));
  assert.ok((X_PUBLISH_SCOPES as readonly string[]).includes("tweet.write"), "documented for a future reconnect");
  const { url } = createXOAuthStart("someone");
  assert.doesNotMatch(new URL(url).searchParams.get("scope")!, /write|like|follow|dm/);
  assert.equal(canUse({ status: "active", scopes: "tweet.read users.read offline.access" }, "analytics"), true);
  assert.equal(canUse({ status: "active", scopes: "tweet.read users.read offline.access" }, "publish"), false);
  assert.equal(canUse({ status: "active", scopes: "tweet.read users.read tweet.write" }, "publish"), false, "the scope alone isn't enough: publishing is off");
  assert.equal(canUse({ status: "needs_reconnect", scopes: "tweet.read users.read" }, "analytics"), false);
  assert.deepEqual(xOAuth.writeCalls, [], "nothing in these tests wrote to X");
});

test("strategy evidence names verified metrics; no follower claim without follower data", () => {
  const evidence = buildEvidence({
    hasAccount: true,
    handle: "me",
    findings: [],
    postsWithImpressions90: 0,
    span90: null,
    span30: null,
    overview30: null,
    posts30: 3,
    postsPrevious30: null,
    replyActivity30: { opportunities: 0, generated: 0, opened: 0, confirmed: 0 },
    privateMetrics: { covered: 3, total: 4, profileClicks: 15, linkClicks: 9, xEngagements: 120, oldestReadingAt: new Date() },
    xConnected: true,
    trends: [],
    leads: { highIntentNew: 0, total: 0 },
    content: { readyDrafts: 0, plannedNext7: 0, confirmedLast30: 0 },
    previousSnapshot: null,
  });
  const verified = evidence.items.find((i) => i.text.startsWith("Verified with your connected X account"))!;
  assert.match(verified.text, /3 of 4 recent posts: 15 profile clicks, 9 link clicks/);
  assert.ok(evidence.missing.some((m) => m.startsWith("No follower readings")));
});
