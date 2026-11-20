// Day 40.1 privacy, security and compliance: X content removal (by post, by
// author, by retention, by X Batch Compliance results), removed content kept
// out of AI and Home, account deletion (every step, partial failures, retry,
// background work, isolation), analytics retention, OpenAI storage off, and
// the encrypted backup format. X, OpenAI and Neon Auth are mocked.
import "./setup/env";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import { eq, inArray } from "drizzle-orm";

import db from "@/db";
import { getDeletionByUserId } from "@/db/queries/accountDeletions";
import { deleteOldAnalyticsEvents, removeXContent } from "@/db/queries/compliance";
import { profilesToPrepare } from "@/db/queries/inbox";
import { getLeadCandidates } from "@/db/queries/leads";
import { getPublication } from "@/db/queries/publications";
import { getPostedReplies } from "@/db/queries/replies";
import { getXConnection } from "@/db/queries/xConnections";
import * as s from "@/db/schema";
import { REMOVED_POST_TEXT, storedPostText, THIRD_PARTY_RETENTION_DAYS } from "@/lib/compliance/retention";
import {
  backupScript,
  backupsToPrune,
  countCsvRows,
  decryptBackup,
  encryptBackup,
  manifestFor,
  splitBackupOutput,
} from "@/lib/ops/backupFormat";
import { createXOAuthStart } from "@/lib/x/oauth";
import { deleteAccount, resumeAccountDeletions } from "@/services/account/deleteAccount";
import { applyComplianceEvents, applyRetention, parseComplianceResults, runComplianceJobs } from "@/services/compliance/xCompliance";
import { loadInbox } from "@/services/inbox/inbox";
import { generateReplies } from "@/services/replies/generateReply";
import { runHourlyRetention } from "@/services/scheduler/cleanup";
import { handleXOAuthCallback } from "@/services/x/oauthConnection";
import { approveForPublishing, runPublishing, schedulePublication } from "@/services/x/publishing";

import { cleanup, getProfile, newProfile, rememberXUsage, trackXUser } from "./helpers/db";
import { ai, installMocks, nextId, x, xOAuth } from "./helpers/mocks";

const DAY = 86_400_000;

before(async () => {
  installMocks();
  await rememberXUsage();
});
after(cleanup);
beforeEach(() => {
  ai.calls.length = 0;
  ai.requests.length = 0;
  x.calls.length = 0;
  xOAuth.revokeFails = false;
  x.compliance.jobs.clear();
  x.compliance.uploadFails = false;
  x.compliance.results = () => "";
  process.env.X_OAUTH_ENABLED = "true";
  process.env.X_PUBLISHING_ENABLED = "true";
  delete process.env.X_COMPLIANCE_JOBS_ENABLED;
});

// ---- Fixtures -------------------------------------------------------------------------

async function run(profileId: string) {
  const [row] = await db.insert(s.scoutRunsTable).values({ profileId, status: "completed" }).returning();
  return row;
}

/** One post by `author`, stored for a profile as a candidate, an opportunity and a lead */
async function storedPost(profileId: string, { postId = nextId(), author = nextId(), ageDays = 1, text = "Looking for a tool to find customers on X" } = {}) {
  const postedAt = new Date(Date.now() - ageDays * DAY);
  const r = await run(profileId);
  const [candidate] = await db
    .insert(s.scoutCandidatesTable)
    .values({ runId: r.id, profileId, platform: "x", platformPostId: postId, authorPlatformUserId: author, authorHandle: "author", content: text, url: `https://x.com/author/status/${postId}`, kind: "post", postedAt, source: "watchlist", scoredAt: new Date(), score: 90, reason: `About: ${text}` })
    .returning();
  const [opportunity] = await db
    .insert(s.opportunitiesTable)
    .values({ scoutRunId: r.id, profileId, platform: "x", platformPostId: postId, authorPlatformUserId: author, authorHandle: "author", content: text, score: 90, reason: `About: ${text}`, postedAt, createdAt: postedAt })
    .returning();
  const [lead] = await db
    .insert(s.leadsTable)
    .values({ profileId, platform: "x", platformPostId: postId, authorPlatformUserId: author, authorHandle: "author", postUrl: `https://x.com/author/status/${postId}`, content: text, postedAt, intent: "high", score: 90, scoreBreakdown: {} as never, evidence: text.slice(0, 20), reason: "Needs a tool.", suggestedAction: "Help." })
    .returning();
  return { postId, author, candidate, opportunity, lead };
}

async function cachedPost(postId: string, author: string) {
  trackXUser(author);
  await db.insert(s.xAccountsTable).values({ platformUserId: author, handle: `a${author.slice(-6)}` }).onConflictDoNothing();
  await db.insert(s.xPostsTable).values({ platformPostId: postId, authorPlatformUserId: author, authorHandle: "author", content: "cached text", url: "https://x.com/a/status/1", kind: "post", postedAt: new Date() });
}

const row = async <T extends { id: string }>(table: typeof s.opportunitiesTable | typeof s.leadsTable | typeof s.scoutCandidatesTable, id: string) =>
  (await db.select().from(table as typeof s.opportunitiesTable).where(eq((table as typeof s.opportunitiesTable).id, id)))[0] as unknown as T & { content: string; contentRemovedAt: Date | null; contentRemovedReason: string | null };

// ---- X content: removal -------------------------------------------------------------------

test("a post deleted on X is removed everywhere Scout stored it, for every user; IDs and links stay", async () => {
  const a = await newProfile();
  const b = await newProfile();
  const postId = nextId();
  const author = nextId();
  const mine = await storedPost(a.id, { postId, author });
  const theirs = await storedPost(b.id, { postId, author });
  const other = await storedPost(a.id);
  await cachedPost(postId, author);
  const [item] = await db
    .insert(s.automationItemsTable)
    .values({ profileId: a.id, kind: "review", eventKey: `opportunity:${mine.opportunity.id}`, sourceModule: "Opportunities", entityType: "opportunity", entityId: mine.opportunity.id, title: "New opportunity", body: "Looking for a tool…", href: "/opportunities" })
    .returning();

  const counts = await removeXContent({ postIds: [postId] }, "deleted");
  assert.equal(counts.cache, 1);
  assert.equal(counts.opportunities, 2, "both users");
  for (const [table, id] of [
    [s.opportunitiesTable, mine.opportunity.id],
    [s.leadsTable, mine.lead.id],
    [s.scoutCandidatesTable, mine.candidate.id],
    [s.opportunitiesTable, theirs.opportunity.id],
  ] as const) {
    const stored = await row(table, id);
    assert.equal(stored.content, "");
    assert.equal(stored.contentRemovedReason, "deleted");
  }
  const opp = (await db.select().from(s.opportunitiesTable).where(eq(s.opportunitiesTable.id, mine.opportunity.id)))[0];
  assert.equal(opp.platformPostId, postId, "the ID stays");
  assert.equal(opp.reason, null, "AI text about it goes too");
  const lead = (await db.select().from(s.leadsTable).where(eq(s.leadsTable.id, mine.lead.id)))[0];
  assert.equal(lead.evidence, "");
  assert.match(lead.postUrl, /status/, "the link stays");
  assert.equal((await db.select().from(s.automationItemsTable).where(eq(s.automationItemsTable.id, item.id)))[0].body, null);
  assert.equal((await db.select().from(s.xPostsTable).where(eq(s.xPostsTable.platformPostId, postId))).length, 0);
  // Another post is untouched
  assert.equal((await row(s.opportunitiesTable, other.opportunity.id)).content.length > 0, true);
  assert.equal(storedPostText(""), REMOVED_POST_TEXT);
});

test("a suspended or protected author: everything they posted is removed", async () => {
  const p = await newProfile();
  const author = nextId();
  const first = await storedPost(p.id, { author });
  const second = await storedPost(p.id, { author });
  const unrelated = await storedPost(p.id);
  const counts = await removeXContent({ authorIds: [author] }, "protected");
  assert.equal(counts.opportunities, 2);
  assert.equal((await row(s.leadsTable, first.lead.id)).contentRemovedReason, "protected");
  assert.equal((await row(s.leadsTable, second.lead.id)).content, "");
  assert.notEqual((await row(s.leadsTable, unrelated.lead.id)).content, "");
});

test("retention: third-party text past its window is removed in bounded passes; recent posts stay", async () => {
  const p = await newProfile();
  const old = await storedPost(p.id, { ageDays: THIRD_PARTY_RETENTION_DAYS.opportunities + 2 });
  const leadKept = await storedPost(p.id, { ageDays: THIRD_PARTY_RETENTION_DAYS.opportunities + 2 });
  const fresh = await storedPost(p.id, { ageDays: 1 });
  await applyRetention();
  assert.equal((await row(s.opportunitiesTable, old.opportunity.id)).contentRemovedReason, "retention");
  assert.equal((await row(s.scoutCandidatesTable, old.candidate.id)).content, "");
  // Leads keep their text longer (90 days)
  assert.notEqual((await row(s.leadsTable, leadKept.lead.id)).content, "");
  assert.notEqual((await row(s.opportunitiesTable, fresh.opportunity.id)).content, "");
  // Hourly: a tick in the middle of the hour does nothing
  assert.deepEqual(await runHourlyRetention(new Date("2026-11-20T10:30:00Z")), {});
});

test("removed content never reaches the AI or Home, and is shown as removed", async () => {
  const p = await newProfile();
  const post = await storedPost(p.id, { ageDays: 0.1 });
  await db.update(s.opportunitiesTable).set({ status: "new" }).where(eq(s.opportunitiesTable.id, post.opportunity.id));
  await db.insert(s.repliesTable).values({ opportunityId: post.opportunity.id, variant: "natural", originalContent: "r", content: "r", status: "approved" });
  assert.equal((await loadInbox(p)).items.some((i) => i.key === `opportunity:${post.opportunity.id}` || i.key === `lead:${post.lead.id}`), true);
  assert.equal((await getPostedReplies(p.id, 10)).length, 1);

  await removeXContent({ postIds: [post.postId] }, "deleted");
  assert.equal((await loadInbox(p)).items.length, 0, "not on Home");
  assert.equal((await getPostedReplies(p.id, 10)).length, 0, "not used as voice context");
  assert.equal((await getLeadCandidates(p.id, { minScore: 0, postedAfter: new Date(0), limit: 10 })).length, 0, "not checked for leads");
  const result = await generateReplies(p.id, post.opportunity.id, { styles: ["natural", "funny"] });
  assert.equal(result.status, "not_found");
  assert.equal(ai.calls.length, 0, "nothing sent to OpenAI");
});

// ---- X Batch Compliance jobs ----------------------------------------------------------------

/** One scheduler pass with jobs enabled */
const jobs = async () => (await runComplianceJobs()) as Record<string, string>;

test("compliance jobs: off by default; on, Scout uploads stored IDs, applies X's answer, once a day", async () => {
  assert.deepEqual(await runComplianceJobs(), { disabled: true });
  assert.equal(x.calls.length, 0, "no X calls while off");

  const p = await newProfile();
  const gone = await storedPost(p.id);
  const kept = await storedPost(p.id);
  process.env.X_COMPLIANCE_JOBS_ENABLED = "true";
  x.compliance.results = (ids) =>
    [
      ids.includes(gone.postId) ? JSON.stringify({ id: gone.postId, action: "delete", reason: "deleted", created_at: "2026-11-19" }) : "",
      JSON.stringify({ id: "not-an-id", error: "invalid_id" }),
      "not json",
    ].join("\n");
  // Earlier jobs from other files' data don't matter: the newest decides
  await db.delete(s.xComplianceJobsTable);
  const first = await jobs();
  assert.equal(first.tweets, "uploaded");
  const [job] = [...x.compliance.jobs.values()].filter((j) => j.type === "tweets");
  assert.ok(job.ids.includes(gone.postId) && job.ids.includes(kept.postId), "the stored IDs were uploaded");

  // X finishes the job
  for (const j of x.compliance.jobs.values()) j.status = "complete";
  const second = await jobs();
  assert.equal(second.tweets, "applied");
  assert.equal((await row(s.opportunitiesTable, gone.opportunity.id)).contentRemovedReason, "deleted");
  assert.notEqual((await row(s.opportunitiesTable, kept.opportunity.id)).content, "");
  const [applied] = await db.select().from(s.xComplianceJobsTable).where(eq(s.xComplianceJobsTable.type, "tweets"));
  assert.equal(applied.results?.invalid, 1);
  assert.equal(applied.downloadUrl, null, "the signed URL isn't kept");
  assert.equal((await jobs()).tweets, "not due");
});

test("compliance jobs: a failed upload is recorded, not looped", async () => {
  const p = await newProfile();
  await storedPost(p.id);
  process.env.X_COMPLIANCE_JOBS_ENABLED = "true";
  await db.delete(s.xComplianceJobsTable);
  x.compliance.uploadFails = true;
  const result = await jobs();
  assert.equal(result.tweets, "failed");
  const [job] = await db.select().from(s.xComplianceJobsTable).where(eq(s.xComplianceJobsTable.type, "tweets"));
  assert.equal(job.status, "failed");
  assert.equal((await jobs()).tweets, "not due", "tried again tomorrow, not every tick");
});

test("compliance events: edits remove the stale copy, location scrubs need nothing, user events go by author", async () => {
  const p = await newProfile();
  const edited = await storedPost(p.id);
  const author = await storedPost(p.id);
  const events = parseComplianceResults(
    [JSON.stringify({ id: edited.postId, action: "rehydrate", reason: "tweet_edited" }), JSON.stringify({ id: "1", action: "scrub_geo", reason: "geo_scrubbed" })].join("\n"),
  );
  const tweets = await applyComplianceEvents("tweets", events);
  assert.equal(tweets.edited, 1);
  assert.equal(tweets.ignored, 1);
  assert.equal((await row(s.opportunitiesTable, edited.opportunity.id)).contentRemovedReason, "edited");
  await applyComplianceEvents("users", [{ id: author.author, action: "delete", reason: "suspended" }]);
  assert.equal((await row(s.leadsTable, author.lead.id)).contentRemovedReason, "suspended");
});

// ---- Analytics retention ---------------------------------------------------------------------

test("analytics events older than the retention are deleted; recent ones stay", async () => {
  const p = await newProfile();
  const [old] = await db.insert(s.analyticsEventsTable).values({ name: "growth_viewed", profileId: p.id, createdAt: new Date(Date.now() - 500 * DAY) }).returning();
  const [recent] = await db.insert(s.analyticsEventsTable).values({ name: "growth_viewed", profileId: p.id }).returning();
  await deleteOldAnalyticsEvents(400, new Date(), 1000);
  const left = await db.select().from(s.analyticsEventsTable).where(inArray(s.analyticsEventsTable.id, [old.id, recent.id]));
  assert.deepEqual(left.map((e) => e.id), [recent.id]);
});

// ---- Account deletion --------------------------------------------------------------------------

async function connectedProfile() {
  const userId = nextId();
  const handle = `d${userId.slice(-8)}`;
  x.users.set(handle.toLowerCase(), userId);
  const p = await newProfile();
  await db.update(s.profilesTable).set({ plan: "pro", xHandle: handle, onboardingCompleted: true, autoScanEnabled: true, autoPrepareEnabled: true }).where(eq(s.profilesTable.id, p.id));
  const profile = await getProfile(p.id);
  const { url, cookie } = createXOAuthStart(profile.id, Date.now(), { publish: true });
  assert.equal((await handleXOAuthCallback(profile, { state: new URL(url).searchParams.get("state"), code: `user:${userId}:write`, error: null, cookie })).status, "publishing_enabled");
  return getProfile(p.id);
}

async function scheduledPost(profile: s.Profile) {
  const [d] = await db
    .insert(s.contentDraftsTable)
    .values({ profileId: profile.id, title: "D", goal: "educate", format: "post", tone: "conversational", length: "short", posts: [`A post ${nextId()}`] })
    .returning();
  const approved = await approveForPublishing(profile, d.id);
  assert.ok(approved.ok);
  const day = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  const scheduled = await schedulePublication(profile, approved.publication.id, { date: day, time: "12:00", timeZone: "UTC" });
  assert.ok(scheduled.ok);
  return { publicationId: approved.publication.id, at: scheduled.scheduledAt };
}

test("account deletion: everything stops, X access is revoked, data and login are deleted; others untouched", async () => {
  const profile = await connectedProfile();
  const other = await newProfile();
  const otherPost = await storedPost(other.id);
  const mine = await storedPost(profile.id);
  const { at } = await scheduledPost(profile);
  const tokensBefore = xOAuth.revoked.length;
  let loginDeletes = 0;

  const result = await deleteAccount(profile, { deleteLogin: async () => (loginDeletes++, true) });
  assert.deepEqual(result, { ok: true, status: "completed" });
  assert.equal(xOAuth.revoked.length - tokensBefore, 2, "refresh and access tokens revoked at X");
  assert.equal(await getXConnection(profile.id), undefined);
  assert.equal(loginDeletes, 1);
  assert.equal((await db.select().from(s.profilesTable).where(eq(s.profilesTable.id, profile.id))).length, 0);
  for (const table of [s.opportunitiesTable, s.leadsTable, s.scoutCandidatesTable, s.xPublicationsTable, s.contentDraftsTable] as const) {
    const rows = await db.select().from(table as typeof s.leadsTable).where(eq((table as typeof s.leadsTable).profileId, profile.id));
    assert.equal(rows.length, 0, "no orphaned rows");
  }
  assert.equal((await row(s.opportunitiesTable, mine.opportunity.id)), undefined);
  assert.notEqual((await row(s.opportunitiesTable, otherPost.opportunity.id)).content, "", "another user's data stays");
  assert.equal((await getDeletionByUserId(profile.userId))?.status, "completed");
  // Nothing publishes after deletion
  await runPublishing({ now: new Date(at.getTime() + 60_000) });
  assert.equal(x.publish.requests.length, 0);
});

test("account deletion stops at X: nothing is deleted, nothing runs, and a retry finishes it", async () => {
  const profile = await connectedProfile();
  const { publicationId } = await scheduledPost(profile);
  await db.insert(s.scanJobsTable).values({ profileId: profile.id, status: "pending" }).onConflictDoNothing();
  xOAuth.revokeFails = true;
  const failed = await deleteAccount(profile, { deleteLogin: async () => true });
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.status === "needs_attention" && !failed.dataDeleted);
  assert.match(!failed.ok ? failed.message : "", /Nothing was deleted/);
  // Processing stopped: no scans, no preparation, no automations, nothing published
  const stopped = await getProfile(profile.id);
  assert.ok(stopped.deletionRequestedAt);
  assert.equal(stopped.autoScanEnabled, false);
  assert.ok(!(await profilesToPrepare(new Date(), 0, 1000)).some((r) => r.id === profile.id));
  assert.equal((await db.select().from(s.scanJobsTable).where(eq(s.scanJobsTable.profileId, profile.id))).length, 0);
  assert.equal((await getPublication(profile.id, publicationId))!.status, "cancelled");
  assert.ok(await getXConnection(profile.id), "the connection stays until X confirms");

  xOAuth.revokeFails = false;
  const retried = await deleteAccount(profile, { deleteLogin: async () => true });
  assert.deepEqual(retried, { ok: true, status: "completed" });
});

test("account deletion: if the login can't be deleted, it isn't reported as done; data is gone, the retry finishes", async () => {
  const profile = await connectedProfile();
  const failed = await deleteAccount(profile, { deleteLogin: async () => false });
  assert.ok(!failed.ok && failed.status === "needs_attention" && failed.dataDeleted);
  assert.equal((await db.select().from(s.profilesTable).where(eq(s.profilesTable.id, profile.id))).length, 0);
  assert.equal((await getDeletionByUserId(profile.userId))?.status, "needs_attention", "blocks re-creating the profile");
  const thrown = await deleteAccount(profile, {
    deleteLogin: async () => {
      throw new Error("Neon Auth down");
    },
  });
  assert.equal(thrown.ok, false);
  assert.deepEqual(await deleteAccount(profile, { deleteLogin: async () => true }), { ok: true, status: "completed" });
});

test("account deletion is blocked by an active paid subscription and by a post being published", async () => {
  const profile = await connectedProfile();
  await db.insert(s.billingSubscriptionsTable).values({ profileId: profile.id, paddleSubscriptionId: `sub_${nextId()}`, paddleCustomerId: "ctm_1", status: "active", lastEventAt: new Date() });
  const blocked = await deleteAccount(profile, { deleteLogin: async () => true });
  assert.ok(!blocked.ok && blocked.status === "blocked");
  assert.match(!blocked.ok ? blocked.message : "", /Cancel your subscription/);
  assert.equal(await getDeletionByUserId(profile.userId), undefined, "nothing started");

  await db.update(s.billingSubscriptionsTable).set({ scheduledChange: { action: "cancel", effectiveAt: "2026-12-01" } }).where(eq(s.billingSubscriptionsTable.profileId, profile.id));
  const { publicationId } = await scheduledPost(profile);
  await db.update(s.xPublicationsTable).set({ status: "publishing" }).where(eq(s.xPublicationsTable.id, publicationId));
  const inFlight = await deleteAccount(profile, { deleteLogin: async () => true });
  assert.match(!inFlight.ok ? inFlight.message : "", /being published/);
});

test("a deletion stopped at the data step is finished by the scheduler", async () => {
  const profile = await newProfile();
  await db.insert(s.accountDeletionsTable).values({
    userId: profile.userId,
    profileId: profile.id,
    status: "needs_attention",
    steps: { processingStopped: true, xRevoked: true, slackRevoked: true },
    updatedAt: new Date(Date.now() - 10 * 60_000),
  });
  const { resumed } = await resumeAccountDeletions();
  assert.ok(resumed >= 1);
  assert.equal((await db.select().from(s.profilesTable).where(eq(s.profilesTable.id, profile.id))).length, 0);
  const record = await getDeletionByUserId(profile.userId);
  assert.equal(record?.steps.dataDeleted, true);
  assert.equal(record?.status, "needs_attention", "the login step still needs the user's session");
});

// ---- OpenAI ---------------------------------------------------------------------------------------

test("OpenAI: every request asks the API not to store the response", async () => {
  const p = await newProfile();
  const post = await storedPost(p.id, { ageDays: 0.1 });
  const result = await generateReplies(p.id, post.opportunity.id, { styles: ["natural", "funny"] });
  assert.equal(result.status, "generated");
  assert.ok(ai.requests.length >= 1);
  assert.ok(ai.requests.every((request) => request.store === false));
});

// ---- Backups --------------------------------------------------------------------------------------

test("backups: encrypted round trip, tampering and wrong keys fail, manifests hold no data", () => {
  const key = Buffer.alloc(32, 9);
  const contents = {
    version: 1 as const,
    createdAt: "2026-11-20T10:00:00.000Z",
    snapshot: "2026-11-20 10:00:00+00",
    tables: [{ name: "public.profiles", rows: 1, csv: 'id,bio\n1,"secret, with\nnewline"\n' }],
  };
  const file = encryptBackup(contents, key);
  assert.ok(!file.includes(Buffer.from("secret")), "no plaintext in the file");
  assert.deepEqual(decryptBackup(file, key), contents);
  const tampered = Buffer.from(file);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptBackup(tampered, key));
  assert.throws(() => decryptBackup(file, Buffer.alloc(32, 1)));
  const manifest = manifestFor("x.scoutbackup", file, contents);
  assert.deepEqual(manifest.tables, [{ name: "public.profiles", rows: 1 }]);
  assert.ok(!JSON.stringify(manifest).includes("secret"));
  assert.equal(countCsvRows(contents.tables[0].csv), 1, "a quoted newline isn't a row");
});

test("backups: one snapshot script, output split by a random marker, retention keeps the newest", () => {
  const script = backupScript(["public.profiles", "neon_auth.user"], "--m--");
  assert.match(script, /repeatable read read only/);
  assert.throws(() => backupScript(['public.x"; drop table y; --'], "--m--"));
  const split = splitBackupOutput('--m-- __snapshot__\n              now\n-------------------------------\n 2026-11-20 10:00:00+00\n(1 row)\n\n--m-- public.profiles\nid\n1\n2\n--m-- neon_auth.user\nid\n', "--m--");
  assert.deepEqual(split.tables.map((t) => [t.name, t.rows]), [["public.profiles", 2], ["neon_auth.user", 0]]);
  const now = new Date("2026-11-20");
  const files = [0, 10, 40, 50, 60].map((days, i) => ({ name: `b${i}`, createdAt: new Date(now.getTime() - days * DAY) }));
  assert.deepEqual(backupsToPrune(files, now, 30), ["b3", "b4"]);
  assert.deepEqual(backupsToPrune(files.slice(2), now, 30), [], "the newest three always stay");
});

test("backups can't be committed by accident", () => {
  const ignore = readFileSync(".gitignore", "utf8");
  for (const pattern of ["/scout-backups/", "*.scoutbackup", "*.scoutbackup.manifest.json", ".env*"]) assert.ok(ignore.includes(pattern), pattern);
});
