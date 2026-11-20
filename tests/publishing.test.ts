// Day 40 X publishing: publishing permission (reconnect), exact-content
// approval, Publish now, scheduling (time zones, concurrent workers, pause,
// cancel, reschedule), plan count and money limits (atomic), link pricing,
// unanswered and refused requests (no blind retries; reconciliation),
// edits after approval, disconnecting, isolation, token refresh. X is
// mocked: nothing is ever published for real.
import "./setup/env";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { eq } from "drizzle-orm";

import db from "@/db";
import { getDraft } from "@/db/queries/content";
import { getPublication, publishSpend, reservePublishSpend } from "@/db/queries/publications";
import { getXConnection } from "@/db/queries/xConnections";
import * as s from "@/db/schema";
import { windowStart } from "@/lib/billing/windows";
import { createXOAuthStart, readXOAuthCookie } from "@/lib/x/oauth";
import { canUse } from "@/lib/x/permissions";
import { comparableText, containsUrl, publishCostUsd, safeReturnPath } from "@/lib/x/publishing";
import { planDraft, unplanDraft } from "@/services/content/calendar";
import { actOnItem, loadInbox, saveText } from "@/services/inbox/inbox";
import { disconnectX, handleXOAuthCallback } from "@/services/x/oauthConnection";
import {
  approveForPublishing,
  deletePublished,
  publishPublication,
  runPublishing,
  schedulePublication,
  unschedulePublication,
} from "@/services/x/publishing";

import { cleanup, getProfile, newProfile, rememberXUsage } from "./helpers/db";
import { installMocks, nextId, x, xOAuth } from "./helpers/mocks";

const MIN = 60_000;
const HOUR = 60 * MIN;

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);
beforeEach(() => {
  process.env.X_OAUTH_ENABLED = "true";
  process.env.X_PUBLISHING_ENABLED = "true";
  delete process.env.X_PUBLISHING_PAUSED;
  x.publish.outcomes.length = 0;
  x.publish.requests.length = 0;
  xOAuth.writeCalls.length = 0;
});

async function xUser(plan: s.Profile["plan"] = "pro") {
  const userId = nextId();
  const handle = `p${userId.slice(-8)}`;
  x.users.set(handle.toLowerCase(), userId);
  const p = await newProfile();
  await db.update(s.profilesTable).set({ plan, xHandle: handle, onboardingCompleted: true }).where(eq(s.profilesTable.id, p.id));
  return { profile: await getProfile(p.id), userId, handle };
}

async function connect(profile: s.Profile, code: string, { publish = false, returnTo = null as string | null } = {}) {
  const { url, cookie } = createXOAuthStart(profile.id, Date.now(), { publish, returnTo });
  const state = new URL(url).searchParams.get("state");
  return handleXOAuthCallback(profile, { state, code, error: null, cookie });
}

/** A profile connected with publishing allowed */
async function publisher(plan: s.Profile["plan"] = "pro") {
  const user = await xUser(plan);
  assert.equal((await connect(user.profile, `user:${user.userId}:write`, { publish: true })).status, "publishing_enabled");
  return { ...user, profile: await getProfile(user.profile.id) };
}

async function draft(profileId: string, text = `Founders: talk to five customers before you build anything. (${nextId().slice(-6)})`) {
  const [row] = await db
    .insert(s.contentDraftsTable)
    .values({ profileId, title: "Prepared", goal: "build_authority", format: "post", tone: "conversational", length: "short", posts: [text], origin: "scout" })
    .returning();
  return row;
}

async function approved(profile: s.Profile, text?: string) {
  const d = await draft(profile.id, text);
  const result = await approveForPublishing(profile, d.id);
  assert.ok(result.ok, !result.ok ? result.message : "");
  return { draft: d, publication: result.publication };
}

// ---- Pure -----------------------------------------------------------------------------

test("link posts cost more: detection is generous, so Scout never reserves less than X charges", () => {
  assert.equal(containsUrl("Read it at https://scout.ai/blog"), true);
  assert.equal(containsUrl("More on scout.ai"), true);
  assert.equal(containsUrl("No link here, just a thought."), false);
  assert.equal(publishCostUsd("plain"), 0.015);
  assert.equal(publishCostUsd("see example.com"), 0.2);
  assert.equal(comparableText("A &amp; B https://t.co/xyz  end"), comparableText("A & B https://scout.ai/long end"));
  assert.equal(safeReturnPath("/dashboard"), "/dashboard");
  assert.equal(safeReturnPath("https://evil.example"), null);
  assert.equal(safeReturnPath("//evil.example"), null);
});

// ---- Permission -------------------------------------------------------------------------

test("publishing permission: never requested by default; asked explicitly, it returns where the user was", async () => {
  const user = await xUser();
  const readOnly = new URL(createXOAuthStart(user.profile.id).url).searchParams.get("scope")!;
  assert.doesNotMatch(readOnly, /tweet\.write/);
  const { url, cookie } = createXOAuthStart(user.profile.id, Date.now(), { publish: true, returnTo: "/dashboard" });
  assert.match(new URL(url).searchParams.get("scope")!, /tweet\.write/);
  assert.deepEqual(readXOAuthCookie(new URL(url).searchParams.get("state"), cookie, user.profile.id)?.returnTo, "/dashboard");

  // Existing read-only connection: can't publish until the user reauthorizes
  assert.equal((await connect(user.profile, `user:${user.userId}`)).status, "connected");
  assert.equal(canUse((await getXConnection(user.profile.id))!, "publish"), false);
  // On X's screen they don't allow publishing: still connected, read-only
  assert.equal((await connect(user.profile, `user:${user.userId}`, { publish: true })).status, "publish_not_granted");
  const allowed = await connect(user.profile, `user:${user.userId}:write`, { publish: true, returnTo: "/dashboard" });
  assert.equal(allowed.status, "publishing_enabled");
  assert.equal(allowed.returnTo, "/dashboard");
  assert.equal(canUse((await getXConnection(user.profile.id))!, "publish"), true);

  // The switch is off: holding the scope isn't enough
  process.env.X_PUBLISHING_ENABLED = "false";
  assert.equal(canUse((await getXConnection(user.profile.id))!, "publish"), false);
});

test("missing tweet.write: nothing is sent to X", async () => {
  const user = await xUser();
  await connect(user.profile, `user:${user.userId}`);
  const profile = await getProfile(user.profile.id);
  const { publication } = await approved(profile);
  const result = await publishPublication(profile, publication.id);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /Enable X publishing/);
  assert.equal(x.publish.requests.length, 0);
  assert.equal((await getPublication(profile.id, publication.id))!.status, "approved", "still approved, waiting for permission");
});

// ---- Publish now ------------------------------------------------------------------------

test("publish now: exactly the approved text, once, recorded with X's ID; the draft becomes published", async () => {
  const { profile, handle, userId } = await publisher();
  const text = "We shipped a feature nobody asked for. Then we talked to customers.";
  const { draft: d, publication } = await approved(profile, text);
  const [first, second] = await Promise.all([publishPublication(profile, publication.id), publishPublication(profile, publication.id)]);
  assert.equal(x.publish.requests.length, 1, "two clicks, one post");
  assert.deepEqual(x.publish.requests[0], { userId, text });
  const winner = [first, second].find((r) => r.ok)!;
  assert.ok(winner.ok);
  assert.match(winner.postUrl!, new RegExp(`^https://x\\.com/${handle}/status/\\d+$`));
  const stored = (await getPublication(profile.id, publication.id))!;
  assert.equal(stored.status, "published");
  assert.equal(stored.xPostId, x.publish.created.at(-1)!.id);
  assert.equal(stored.costUsd, 0.015);
  assert.ok(stored.publishedAt);
  const after = (await getDraft(profile.id, d.id))!;
  assert.ok(after.publishedConfirmedAt);
  assert.equal(after.publishedUrl, winner.postUrl);
  const again = await publishPublication(profile, publication.id);
  assert.ok(again.ok && again.message === "Already published.");
  assert.equal(x.publish.requests.length, 1);
});

test("approval holds exact text: an edit cancels it and the post needs approving again", async () => {
  const { profile } = await publisher();
  const d = await draft(profile.id);
  // Approved from Home: the Inbox approval and the publication together
  const approval = await actOnItem(profile, `draft:${d.id}`, "approve");
  assert.ok(approval.ok && approval.publicationId);
  const home = await loadInbox(profile);
  assert.deepEqual(home.items.map((i) => i.type), ["publish"]);
  assert.equal(home.items[0].label, "Ready to publish");

  assert.ok((await saveText(profile, `draft:${d.id}`, "A different text the user typed afterwards.")).ok);
  const cancelled = (await getPublication(profile.id, approval.publicationId!))!;
  assert.equal(cancelled.status, "cancelled");
  const refused = await publishPublication(profile, cancelled.id);
  assert.equal(refused.ok, false);
  assert.equal(x.publish.requests.length, 0);
  // Back on Home as "Post ready", to approve the new text
  assert.deepEqual((await loadInbox(profile)).items.map((i) => i.type), ["post"]);
  const again = await actOnItem(profile, `draft:${d.id}`, "approve");
  assert.ok(again.ok && again.publicationId && again.publicationId !== approval.publicationId);
  assert.equal((await getPublication(profile.id, again.publicationId!))!.text, "A different text the user typed afterwards.");
});

test("users are isolated: no one can publish, schedule or delete another user's post", async () => {
  const owner = await publisher();
  const other = await publisher();
  const { publication } = await approved(owner.profile);
  assert.equal((await publishPublication(other.profile, publication.id)).ok, false);
  assert.equal((await schedulePublication(other.profile, publication.id, { date: "2030-01-01", time: "10:00", timeZone: "UTC" })).ok, false);
  assert.equal((await approveForPublishing(other.profile, publication.draftId!)).ok, false);
  assert.equal((await deletePublished(other.profile, publication.id)).ok, false);
  assert.equal(x.publish.requests.length, 0);
});

// ---- Limits -----------------------------------------------------------------------------

test("plan limits: Starter publishes 3 a week; Free publishes nothing from Scout", async () => {
  const starter = await publisher("starter");
  for (let i = 0; i < 3; i++) {
    const { publication } = await approved(starter.profile);
    assert.ok((await publishPublication(starter.profile, publication.id)).ok);
  }
  const { publication: fourth } = await approved(starter.profile);
  const refused = await publishPublication(starter.profile, fourth.id);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.message : "", /3 posts a week/);
  assert.equal((await getPublication(starter.profile.id, fourth.id))!.status, "approved", "still approved, nothing spent");
  assert.ok(Math.abs((await publishSpend(starter.profile.id, windowStart("month", new Date()))) - 0.045) < 1e-9);

  const free = await publisher("free");
  const { publication: freePost } = await approved(free.profile);
  const blocked = await publishPublication(free.profile, freePost.id);
  assert.equal(blocked.ok, false);
  assert.match(!blocked.ok ? blocked.message : "", /plan doesn't include publishing/);
  assert.equal(x.publish.requests.length, 3);
});

test("money limit is atomic and stops before the cap", async () => {
  const { profile } = await publisher("internal");
  const month = windowStart("month", new Date());
  const results = await Promise.all(Array.from({ length: 10 }, () => reservePublishSpend(profile.id, month, 0.015, 0.06)));
  assert.equal(results.filter(Boolean).length, 4);
  await db.update(s.profilesTable).set({ usageLimitOverrides: { maxPublishingUsdPerMonth: 0.06 } }).where(eq(s.profilesTable.id, profile.id));
  const p = await getProfile(profile.id);
  const { publication } = await approved(p);
  const refused = await publishPublication(p, publication.id);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.message : "", /allowance is used up/);
  assert.equal(x.publish.requests.length, 0);
});

test("link posts within a small cap: the $0.20 reservation is what decides", async () => {
  const { profile } = await publisher("internal");
  await db.update(s.profilesTable).set({ usageLimitOverrides: { maxPublishingUsdPerMonth: 0.21 } }).where(eq(s.profilesTable.id, profile.id));
  const p = await getProfile(profile.id);
  const { publication: link } = await approved(p, "Our guide is up at https://scout.ai/guide");
  assert.equal(link.hasUrl, true);
  assert.ok((await publishPublication(p, link.id)).ok);
  assert.equal((await getPublication(p.id, link.id))!.costUsd, 0.2);
  const { publication: plain } = await approved(p);
  const refused = await publishPublication(p, plain.id);
  assert.equal(refused.ok, false, "0.20 + 0.015 is over 0.21");
  assert.equal(x.publish.requests.length, 1);
});

// ---- Failures -----------------------------------------------------------------------------

test("no answer from X: never retried blindly; Scout finds the post on the timeline and records it", async () => {
  const { profile } = await publisher();
  const { publication } = await approved(profile);
  x.publish.outcomes.push("lost");
  const first = await publishPublication(profile, publication.id);
  assert.equal(first.ok, false);
  assert.match(!first.ok ? first.message : "", /don't publish it again/);
  assert.equal((await getPublication(profile.id, publication.id))!.status, "unknown");
  // Clicking again does nothing while Scout checks
  assert.equal((await publishPublication(profile, publication.id)).ok, false);
  assert.equal(x.publish.requests.length, 1);

  const check = await runPublishing({ now: new Date(Date.now() + 2 * MIN) });
  assert.equal(check.reconciled, 1);
  const stored = (await getPublication(profile.id, publication.id))!;
  assert.equal(stored.status, "published");
  assert.equal(stored.xPostId, x.publish.created.at(-1)!.id);
  assert.ok(stored.reconcileReads > 0, "the check's reads are counted");
  assert.equal(x.publish.requests.length, 1, "never posted twice");
});

test("no answer and not on the timeline: after a few checks it's failed, slot and money given back", async () => {
  const { profile } = await publisher();
  const { publication } = await approved(profile);
  x.publish.outcomes.push("500");
  await publishPublication(profile, publication.id);
  const month = windowStart("month", new Date());
  assert.ok(Math.abs((await publishSpend(profile.id, month)) - 0.015) < 1e-9, "held while unknown");
  for (let i = 1; i <= 3; i++) await runPublishing({ now: new Date(Date.now() + (i * 3 + 1) * MIN) });
  const stored = (await getPublication(profile.id, publication.id))!;
  assert.equal(stored.status, "failed");
  assert.equal(stored.windowSlot, null);
  assert.ok(Math.abs(await publishSpend(profile.id, month)) < 1e-9);
  // Now it's safe to try again
  assert.ok((await publishPublication(profile, publication.id)).ok);
  assert.equal(x.publish.requests.length, 2);
});

test("a network error after X created the post is reconciled the same way", async () => {
  const { profile } = await publisher();
  const { publication } = await approved(profile);
  x.publish.outcomes.push("network");
  await publishPublication(profile, publication.id);
  await runPublishing({ now: new Date(Date.now() + 2 * MIN) });
  assert.equal((await getPublication(profile.id, publication.id))!.status, "published");
});

test("X refuses: duplicate text, rate limit, revoked access; nothing is held", async () => {
  const { profile } = await publisher();
  const month = windowStart("month", new Date());
  const { publication: dup } = await approved(profile);
  x.publish.outcomes.push("dup");
  const duplicate = await publishPublication(profile, dup.id);
  assert.match(!duplicate.ok ? duplicate.message : "", /duplicate/);
  assert.equal((await getPublication(profile.id, dup.id))!.status, "failed");
  assert.ok(Math.abs(await publishSpend(profile.id, month)) < 1e-9);

  x.publish.outcomes.push("401");
  const revoked = await publishPublication(profile, dup.id);
  assert.match(!revoked.ok ? revoked.message : "", /reconnect/);
  assert.equal((await getXConnection(profile.id))!.status, "needs_reconnect");
});

test("a rate-limited scheduled post goes back to its schedule and tries again later", async () => {
  const { profile } = await publisher();
  const { publication } = await approved(profile);
  const at = new Date(Date.now() + 10 * MIN);
  await db.update(s.xPublicationsTable).set({ status: "scheduled", scheduledAt: at }).where(eq(s.xPublicationsTable.id, publication.id));
  x.publish.outcomes.push("429");
  await runPublishing({ now: new Date(at.getTime() + MIN) });
  const stored = (await getPublication(profile.id, publication.id))!;
  assert.equal(stored.status, "scheduled");
  assert.ok(stored.nextAttemptAt && stored.nextAttemptAt > at);
  assert.equal(stored.windowSlot, null, "the slot is free again");
});

// ---- Scheduling -------------------------------------------------------------------------

test("schedule: the user's time zone, the Calendar shows it, published once by concurrent workers", async () => {
  const { profile } = await publisher();
  const { draft: d, publication } = await approved(profile);
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const result = await schedulePublication(profile, publication.id, { date: day, time: "10:30", timeZone: "Europe/Belgrade" });
  assert.ok(result.ok, !result.ok ? result.message : "");
  // Belgrade is UTC+1 in winter: 10:30 there is 09:30 UTC
  assert.equal(result.scheduledAt.toISOString(), `${day}T09:30:00.000Z`);
  assert.equal((await getDraft(profile.id, d.id))!.plannedAt?.toISOString(), result.scheduledAt.toISOString());

  assert.equal((await runPublishing({ now: new Date(result.scheduledAt.getTime() - MIN) })).published, 0, "not before its time");
  const at = new Date(result.scheduledAt.getTime() + MIN);
  const [a, b] = await Promise.all([runPublishing({ now: at }), runPublishing({ now: at })]);
  assert.equal(a.published + b.published, 1);
  assert.equal(x.publish.requests.length, 1);
  assert.equal((await getPublication(profile.id, publication.id))!.status, "published");
  const [note] = await db.select().from(s.automationItemsTable).where(eq(s.automationItemsTable.entityId, publication.id));
  assert.match(note.title, /live on X/);
});

test("schedule: cancel, reschedule, past times refused, paused publishing waits, a very late post isn't published silently", async () => {
  const { profile } = await publisher();
  const { draft: d, publication } = await approved(profile);
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await schedulePublication(profile, publication.id, { date: "2020-01-01", time: "10:00", timeZone: "UTC" })).ok, false);
  assert.ok((await schedulePublication(profile, publication.id, { date: day, time: "08:00", timeZone: "UTC" })).ok);
  assert.ok((await schedulePublication(profile, publication.id, { date: day, time: "09:00", timeZone: "UTC" })).ok, "rescheduled");
  assert.ok((await unschedulePublication(profile, publication.id)).ok);
  assert.equal((await getPublication(profile.id, publication.id))!.status, "approved");
  assert.equal((await getDraft(profile.id, d.id))!.plannedAt, null);

  const scheduled = await schedulePublication(profile, publication.id, { date: day, time: "09:00", timeZone: "UTC" });
  assert.ok(scheduled.ok);
  process.env.X_PUBLISHING_PAUSED = "true";
  const paused = await runPublishing({ now: new Date(scheduled.scheduledAt.getTime() + MIN) });
  assert.ok(paused.paused);
  assert.equal(x.publish.requests.length, 0);
  delete process.env.X_PUBLISHING_PAUSED;
  // Resumed a day later: too late to publish without asking
  await runPublishing({ now: new Date(scheduled.scheduledAt.getTime() + 24 * HOUR) });
  const late = (await getPublication(profile.id, publication.id))!;
  assert.equal(late.status, "failed");
  assert.match(late.error ?? "", /missed its time/);
  assert.equal(x.publish.requests.length, 0);
});

test("an edited scheduled post isn't published: the schedule is cancelled until approved again", async () => {
  const { profile } = await publisher();
  const { draft: d, publication } = await approved(profile);
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const scheduled = await schedulePublication(profile, publication.id, { date: day, time: "12:00", timeZone: "UTC" });
  assert.ok(scheduled.ok);
  // Edited in Content Studio after scheduling
  await db.update(s.contentDraftsTable).set({ posts: ["Edited elsewhere, without updateDraft"] }).where(eq(s.contentDraftsTable.id, d.id));
  await runPublishing({ now: new Date(scheduled.scheduledAt.getTime() + MIN) });
  assert.equal(x.publish.requests.length, 0, "even when the edit bypassed the approval reset");
  assert.equal((await getPublication(profile.id, publication.id))!.status, "cancelled");
});

test("disconnecting X cancels what's scheduled: nothing publishes after consent ends", async () => {
  const { profile } = await publisher();
  const { publication } = await approved(profile);
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const scheduled = await schedulePublication(profile, publication.id, { date: day, time: "12:00", timeZone: "UTC" });
  assert.ok(scheduled.ok);
  await disconnectX(profile.id);
  assert.equal((await getPublication(profile.id, publication.id))!.status, "cancelled");
  await runPublishing({ now: new Date(scheduled.scheduledAt.getTime() + MIN) });
  assert.equal(x.publish.requests.length, 0);
});

test("publishing off: nothing runs, nothing is sent", async () => {
  const { profile } = await publisher();
  const { publication } = await approved(profile);
  process.env.X_PUBLISHING_ENABLED = "false";
  assert.equal((await publishPublication(profile, publication.id)).ok, false);
  assert.deepEqual(await runPublishing(), { published: 0, failed: 0, reconciled: 0, disabled: true });
  assert.equal(x.publish.requests.length, 0);
  assert.deepEqual((await loadInbox(profile)).items.filter((i) => i.type === "publish"), [], "no publishing cards either");
});

test("an expired token is refreshed (rotated) and keeps its publishing permission", async () => {
  const { profile } = await publisher();
  const connection = (await getXConnection(profile.id))!;
  await db.update(s.xConnectionsTable).set({ accessTokenExpiresAt: new Date(Date.now() - MIN) }).where(eq(s.xConnectionsTable.id, connection.id));
  const { publication } = await approved(profile);
  assert.ok((await publishPublication(profile, publication.id)).ok);
  const refreshed = (await getXConnection(profile.id))!;
  assert.notEqual(refreshed.encryptedRefreshToken, connection.encryptedRefreshToken, "rotated");
  assert.equal(x.publish.requests.length, 1);
});

test("delete from X: only posts Scout published, and the draft is no longer marked published", async () => {
  const { profile } = await publisher();
  const { draft: d, publication } = await approved(profile);
  assert.ok((await publishPublication(profile, publication.id)).ok);
  const stored = (await getPublication(profile.id, publication.id))!;
  assert.ok((await deletePublished(profile, publication.id)).ok);
  assert.deepEqual(x.publish.deleted.at(-1), stored.xPostId);
  assert.ok((await getPublication(profile.id, publication.id))!.deletedAt);
  assert.equal((await getDraft(profile.id, d.id))!.publishedConfirmedAt, null);
});

test("only the user's own posts: publishing sends text alone (no reply target), threads are refused", async () => {
  const { profile } = await publisher();
  const { publication } = await approved(profile);
  await publishPublication(profile, publication.id);
  assert.deepEqual(Object.keys(x.publish.requests[0]).sort(), ["text", "userId"]);
  const [thread] = await db
    .insert(s.contentDraftsTable)
    .values({ profileId: profile.id, title: "T", goal: "educate", format: "thread", tone: "conversational", length: "short", posts: ["one", "two"] })
    .returning();
  assert.equal((await approveForPublishing(profile, thread.id)).ok, false);
});

test("the Calendar plan can't silently move a post scheduled to publish", async () => {
  const { profile } = await publisher();
  const { draft: d, publication } = await approved(profile);
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const scheduled = await schedulePublication(profile, publication.id, { date: day, time: "12:00", timeZone: "UTC" });
  assert.ok(scheduled.ok);
  const moved = await planDraft(profile, d.id, { date: day, time: "18:00", timeZone: "UTC" });
  assert.equal(moved.ok, false);
  assert.equal((await unplanDraft(profile, d.id)).ok, false);
  assert.equal((await getDraft(profile.id, d.id))!.plannedAt?.toISOString(), scheduled.scheduledAt.toISOString());
});
