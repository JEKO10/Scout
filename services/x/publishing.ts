import "server-only";

import { z } from "zod";

import { insertItem } from "@/db/queries/automations";
import { getDraft, updateDraft } from "@/db/queries/content";
import { getProfileById } from "@/db/queries/profiles";
import {
  adjustPublishSpend,
  claimPublication,
  duePublications,
  expiredPublishing,
  getActivePublicationForDraft,
  getPublication,
  insertPublication,
  leaseUnknown,
  publishSpend,
  reservePublishSpend,
  scheduledPublications,
  slotsUsed,
  takeWindowSlot,
  transitionPublication,
  unknownToReconcile,
} from "@/db/queries/publications";
import { claimXConnection, getXConnection, markXConnectionNeedsReconnect, releaseXConnection } from "@/db/queries/xConnections";
import type { Profile, XPublication } from "@/db/schema";
import { effectiveLimits } from "@/lib/billing/plans";
import { windowStart } from "@/lib/billing/windows";
import { isValidTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/content/calendar";
import { countXChars, X_POST_LIMIT } from "@/lib/content/types";
import type { PublicationCard } from "@/lib/inbox/types";
import { createXPost, deleteXPost, getOwnRecentPosts, XApiRequestError } from "@/lib/x/client";
import { canUse } from "@/lib/x/permissions";
import { X_PRICING } from "@/lib/x/pricing";
import { comparableText, containsUrl, MAX_LATE_HOURS, type PublicationStatus, publishCostUsd, SCHEDULE_LIMITS } from "@/lib/x/publishing";
import { track } from "@/services/analytics/track";

import { getXAccessToken, XReconnectRequiredError } from "./oauthConnection";

// Day 40 X publishing: the user's own posts, only the exact text they
// approved, only to the X account they connected with publishing allowed.
// Replies to other people's posts are never published here (X allows API
// replies only when the author summoned the account); they stay in X's own
// composer. Nothing is published without an approval of that exact text.

export type PublishResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** Off everywhere unless X_PUBLISHING_ENABLED=true */
export function publishingAvailable(): boolean {
  return process.env.X_PUBLISHING_ENABLED === "true";
}

/** Global pause for scheduled publishing (X_PUBLISHING_PAUSED=true): nothing scheduled goes out */
export function publishingPaused(): boolean {
  return process.env.X_PUBLISHING_PAUSED === "true";
}

/** Lease on the X connection while Scout publishes (a token refresh must not run twice) */
const CONNECTION_LEASE_MINUTES = 2;
/** An unanswered request is looked for on the timeline after this, at most this many times */
const RECONCILE_AFTER_MS = 60_000;
const MAX_RECONCILE_CHECKS = 3;

/** What the user can do with publishing right now (Settings, Home, Studio) */
export async function getPublishingState(profile: Pick<Profile, "id" | "plan" | "usageLimitOverrides">) {
  const available = publishingAvailable();
  const connection = available ? await getXConnection(profile.id) : undefined;
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  return {
    available,
    connected: Boolean(connection),
    /** Connected with tweet.write (and publishing on) */
    canPublish: Boolean(connection && canUse(connection, "publish")),
    planAllows: limits.maxPublishedPosts > 0,
    window: limits.publishWindow,
    maxPosts: limits.maxPublishedPosts,
    monthlyCapUsd: limits.maxPublishingUsdPerMonth,
  };
}

const notify = (profileId: string, publication: XPublication, title: string, body: string | null) =>
  insertItem({
    profileId,
    automationId: null,
    runId: null,
    kind: "notification",
    eventKey: `publication:${publication.id}:${publication.status}:${publication.attempts}`,
    sourceModule: "Content",
    entityType: "publication",
    entityId: publication.id,
    title,
    body,
    href: "/calendar",
  });

// ---- Approval ---------------------------------------------------------------------

/**
 * The user approves this exact text for publishing. Idempotent: the same
 * text approved again returns the same publication. Single posts only.
 */
export async function approveForPublishing(profile: Pick<Profile, "id">, draftId: string): Promise<PublishResult<{ publication: XPublication }>> {
  const draft = await getDraft(profile.id, draftId);
  if (!draft) return { ok: false, message: "This draft is gone." };
  if (draft.format !== "post" || draft.posts.length !== 1) return { ok: false, message: "Scout publishes single posts. Post threads on X yourself." };
  const text = (draft.posts[0] ?? "").trim();
  if (!text) return { ok: false, message: "The post is empty." };
  if (countXChars(text) > X_POST_LIMIT) return { ok: false, message: `It's over ${X_POST_LIMIT} characters. Shorten it first.` };
  if (draft.publishedConfirmedAt) return { ok: false, message: "This post is already published." };

  const active = await getActivePublicationForDraft(profile.id, draftId);
  if (active && active.text === draft.posts[0]) return { ok: true, publication: active };
  const connection = await getXConnection(profile.id);
  const created = await insertPublication({ profileId: profile.id, draftId, xUserId: connection?.xUserId ?? null, text: draft.posts[0], hasUrl: containsUrl(text) });
  const publication = created ?? (await getActivePublicationForDraft(profile.id, draftId));
  if (!publication) return { ok: false, message: "Couldn't approve it. Try again." };
  if (created) await track("x_publish_approved", { profileId: profile.id });
  return { ok: true, publication };
}

// ---- Publishing -------------------------------------------------------------------

export type PublishOutcome = PublishResult<{ status: PublicationStatus; message: string; postUrl?: string }>;

/**
 * Publishes one approved post: now (the user clicked) or scheduled (the
 * scheduler). Order: checks that change nothing → claim (one worker) →
 * window slot (plan count) → spend reservation (plan money) → token → one
 * POST. Whatever stops it before X gives back the slot and the money.
 */
export async function publishPublication(
  profile: Profile,
  publicationId: string,
  { mode = "now", now = new Date() }: { mode?: "now" | "scheduled"; now?: Date } = {},
): Promise<PublishOutcome> {
  const pub = await getPublication(profile.id, publicationId);
  if (!pub) return { ok: false, message: "This post is gone." };
  if (pub.status === "published") return { ok: true, status: "published", message: "Already published." };
  if (pub.status === "publishing" || pub.status === "unknown") return { ok: false, message: "Scout is still checking with X whether it was published." };
  if (pub.status === "cancelled") return { ok: false, message: pub.error ?? "This approval was cancelled. Approve the post again." };
  if (!publishingAvailable()) return { ok: false, message: "Publishing from Scout isn't available yet." };
  if (mode === "scheduled" && publishingPaused()) return { ok: false, message: "Scheduled publishing is paused." };

  // A scheduled failure is recorded and notified; a click just answers
  const fail = async (message: string, status: "failed" | "cancelled" = "failed"): Promise<PublishOutcome> => {
    if (mode === "scheduled" || status === "cancelled") {
      const moved = await transitionPublication(profile.id, pub.id, [pub.status], { status, error: message, scheduledAt: status === "cancelled" ? null : pub.scheduledAt });
      if (moved && mode === "scheduled") await notify(profile.id, moved, "A scheduled post didn't publish", message);
    }
    return { ok: false, message };
  };

  const draft = pub.draftId ? await getDraft(profile.id, pub.draftId) : undefined;
  if (!draft || draft.posts[0] !== pub.text) return fail("The post changed after you approved it. Approve the new version.", "cancelled");
  const connection = await getXConnection(profile.id);
  if (!connection) return fail("Connect X to publish.");
  if (!canUse(connection, "publish")) return fail(connection.status === "active" ? "Enable X publishing first." : "Reconnect X to publish.");
  if (pub.xUserId && pub.xUserId !== connection.xUserId) return fail("You approved it for another X account. Approve it again.", "cancelled");
  if (mode === "scheduled" && pub.scheduledAt && now.getTime() - pub.scheduledAt.getTime() > MAX_LATE_HOURS * 3_600_000) {
    return fail("It missed its time while publishing was paused. Publish it now or pick a new time.");
  }
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  if (limits.maxPublishedPosts <= 0) return fail("Your plan doesn't include publishing from Scout. Copy the post and publish it on X.");

  const from: PublicationStatus[] = mode === "now" ? ["approved", "scheduled", "failed"] : ["scheduled"];
  const claimed = await claimPublication(profile.id, pub.id, from, now);
  if (!claimed) return { ok: false, message: "It's already being published." };
  const back = (patch: Partial<XPublication>) => transitionPublication(profile.id, pub.id, ["publishing"], { claimedUntil: null, ...patch });

  // The plan's count: one slot of the window
  const window = windowStart(limits.publishWindow, now);
  if (!(await takeWindowSlot(profile.id, pub.id, window, limits.maxPublishedPosts))) {
    const message = `Your plan publishes ${limits.maxPublishedPosts} post${limits.maxPublishedPosts === 1 ? "" : "s"} a ${limits.publishWindow} from Scout. ${pub.status === "scheduled" ? "Pick a later time" : "Schedule it"} or copy it to X.`;
    await back({ status: pub.status === "scheduled" ? "failed" : pub.status, error: message });
    return { ok: false, message };
  }
  const freeSlot = () => transitionPublication(profile.id, pub.id, ["publishing", "failed", "scheduled", "approved"], { windowStart: null, windowSlot: null });

  // The plan's money: the exact price, reserved before the call
  const cost = publishCostUsd(pub.text);
  const month = windowStart("month", now);
  if (!(await reservePublishSpend(profile.id, month, cost, limits.maxPublishingUsdPerMonth))) {
    await freeSlot();
    const message = `This month's publishing allowance is used up${pub.hasUrl ? " (posts with a link cost more on X)" : ""}. Copy it and post it on X.`;
    await back({ status: pub.status === "scheduled" ? "failed" : pub.status, error: message });
    return { ok: false, message };
  }
  // Recorded on the row, so whoever settles it later (a check after no answer) knows what's held
  await transitionPublication(profile.id, pub.id, ["publishing"], { reservedUsd: cost });
  const refund = async () => {
    await adjustPublishSpend(profile.id, month, -cost);
    await transitionPublication(profile.id, pub.id, ["publishing"], { reservedUsd: 0 });
    await freeSlot();
  };

  // The token: one user of the connection at a time (refresh tokens rotate)
  const lease = await claimXConnection(profile.id, now, CONNECTION_LEASE_MINUTES);
  if (!lease) {
    await refund();
    await back(mode === "scheduled" ? { status: "scheduled", nextAttemptAt: new Date(now.getTime() + 5 * 60_000) } : { status: pub.status, error: null });
    return { ok: false, message: "Scout is syncing with X. Try again in a minute." };
  }
  let result: Awaited<ReturnType<typeof createXPost>>;
  try {
    let token: string;
    try {
      token = await getXAccessToken(lease, now);
    } catch (error) {
      await refund();
      const message = error instanceof XReconnectRequiredError ? "X needs you to reconnect before Scout can publish." : "Couldn't reach X. Try again.";
      const moved = await back({ status: "failed", error: message });
      if (moved && mode === "scheduled") await notify(profile.id, moved, "A scheduled post didn't publish", message);
      return { ok: false, message };
    }
    result = await createXPost(token, pub.text);
  } finally {
    await releaseXConnection(lease.id);
  }

  if (result.kind === "created") {
    const postUrl = `https://x.com/${connection.handle}/status/${result.id}`;
    const done = await back({ status: "published", xPostId: result.id, publishedAt: now, costUsd: cost, reservedUsd: cost, xUserId: connection.xUserId, error: null, nextAttemptAt: null });
    // X confirmed it: the draft is published (with its link), for Content and the Calendar
    await updateDraft(profile.id, draft.id, { publishedConfirmedAt: now, publishedUrl: postUrl, status: "ready", archivedAt: null });
    if (done && mode === "scheduled") await notify(profile.id, done, "Your scheduled post is live on X", pub.text.slice(0, 140));
    await track("x_post_published", { profileId: profile.id, props: { mode, link: pub.hasUrl } });
    return { ok: true, status: "published", message: "Published on X.", postUrl };
  }

  if (result.kind === "ambiguous") {
    // Maybe published: the slot and the money stay held, and nothing is retried until Scout has checked X
    await back({ status: "unknown", error: "X didn't confirm. Scout is checking whether it was published." });
    return { ok: false, message: "X didn't confirm the post. Scout is checking whether it went out; don't publish it again yet." };
  }

  // X said no: nothing was created
  await refund();
  if (result.status === 401) await markXConnectionNeedsReconnect(connection.id, "X answered 401 to a post");
  const message =
    result.status === 401
      ? "X needs you to reconnect before Scout can publish."
      : result.status === 403
        ? /duplicate/i.test(result.message)
          ? "X refused it: it looks like a duplicate of one of your recent posts."
          : "X refused it (no permission). Enable X publishing again in Settings."
        : result.status === 429
          ? "X's posting limit is reached for now. Scout tries again later."
          : `X refused it: ${result.message.slice(0, 160)}`;
  if (result.status === 429 && mode === "scheduled") {
    await back({ status: "scheduled", nextAttemptAt: result.retryAt ?? new Date(now.getTime() + 15 * 60_000), error: message });
    return { ok: false, message };
  }
  const moved = await back({ status: "failed", error: message });
  if (moved && mode === "scheduled") await notify(profile.id, moved, "A scheduled post didn't publish", message);
  return { ok: false, message };
}

// ---- Scheduling -------------------------------------------------------------------

const scheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date."),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time."),
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone."),
});

/**
 * Schedules (or reschedules) an approved post. Checked now against the
 * plan's count and money for that window; checked again when it publishes.
 */
export async function schedulePublication(
  profile: Profile,
  publicationId: string,
  raw: z.input<typeof scheduleSchema>,
  now = new Date(),
): Promise<PublishResult<{ scheduledAt: Date }>> {
  const parsed = scheduleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the date." };
  const pub = await getPublication(profile.id, publicationId);
  if (!pub || !["approved", "scheduled", "failed"].includes(pub.status)) return { ok: false, message: "Approve the post first." };
  const scheduledAt = zonedTimeToUtc(parsed.data.date, parsed.data.time, parsed.data.timeZone);
  if (!scheduledAt) return { ok: false, message: "That date doesn't exist." };
  if (scheduledAt.getTime() < now.getTime() + SCHEDULE_LIMITS.minAheadMinutes * 60_000) return { ok: false, message: "Pick a time at least a few minutes from now." };
  if (scheduledAt.getTime() > now.getTime() + SCHEDULE_LIMITS.maxAheadDays * 86_400_000) return { ok: false, message: `Pick a time within ${SCHEDULE_LIMITS.maxAheadDays} days.` };

  const state = await getPublishingState(profile);
  if (!state.available) return { ok: false, message: "Publishing from Scout isn't available yet." };
  if (!state.planAllows) return { ok: false, message: "Your plan doesn't include publishing from Scout." };
  if (!state.canPublish) return { ok: false, message: "Enable X publishing first." };
  const draft = pub.draftId ? await getDraft(profile.id, pub.draftId) : undefined;
  if (!draft || draft.posts[0] !== pub.text) return { ok: false, message: "The post changed after you approved it. Approve the new version." };

  // Room in that window and that month, counting what's already scheduled there
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  const window = windowStart(limits.publishWindow, scheduledAt);
  const month = windowStart("month", scheduledAt);
  const others = (await scheduledPublications(profile.id)).filter((p) => p.id !== pub.id && p.scheduledAt);
  const inWindow = others.filter((p) => windowStart(limits.publishWindow, p.scheduledAt!) === window).length;
  if ((await slotsUsed(profile.id, window)) + inWindow >= limits.maxPublishedPosts) {
    return { ok: false, message: `That ${limits.publishWindow} is full: your plan publishes ${limits.maxPublishedPosts} post${limits.maxPublishedPosts === 1 ? "" : "s"} a ${limits.publishWindow}. Pick another ${limits.publishWindow === "day" ? "day" : "week"}.` };
  }
  const plannedSpend = others.filter((p) => windowStart("month", p.scheduledAt!) === month).reduce((sum, p) => sum + publishCostUsd(p.text), 0);
  if ((await publishSpend(profile.id, month)) + plannedSpend + publishCostUsd(pub.text) > limits.maxPublishingUsdPerMonth + 1e-9) {
    return { ok: false, message: "That month's publishing allowance is already planned out. Pick a later month or copy it to X." };
  }

  const moved = await transitionPublication(profile.id, pub.id, ["approved", "scheduled", "failed"], {
    status: "scheduled",
    scheduledAt,
    timeZone: parsed.data.timeZone,
    nextAttemptAt: null,
    error: null,
  });
  if (!moved) return { ok: false, message: "It's being published right now." };
  // The Calendar shows it on that day (its plan, not a copy)
  await updateDraft(profile.id, draft.id, { plannedAt: scheduledAt, timeZone: parsed.data.timeZone, missedNotedAt: null });
  await track("x_publish_scheduled", { profileId: profile.id });
  return { ok: true, scheduledAt };
}

/** Back to "Ready to publish"; the post stays approved */
export async function unschedulePublication(profile: Pick<Profile, "id">, publicationId: string): Promise<PublishResult> {
  const moved = await transitionPublication(profile.id, publicationId, ["scheduled"], { status: "approved", scheduledAt: null, nextAttemptAt: null });
  if (!moved) return { ok: false, message: "It isn't scheduled (anymore)." };
  if (moved.draftId) await updateDraft(profile.id, moved.draftId, { plannedAt: null });
  return { ok: true };
}

/** Deletes a post Scout published from X (the user asked; tweet.write) */
export async function deletePublished(profile: Profile, publicationId: string, now = new Date()): Promise<PublishResult> {
  const pub = await getPublication(profile.id, publicationId);
  if (!pub || pub.status !== "published" || !pub.xPostId) return { ok: false, message: "Only posts Scout published can be deleted here." };
  if (pub.deletedAt) return { ok: true };
  const connection = await getXConnection(profile.id);
  if (!connection || !canUse(connection, "publish") || connection.xUserId !== pub.xUserId) return { ok: false, message: "Reconnect the X account it was published on, with publishing enabled." };
  const lease = await claimXConnection(profile.id, now, CONNECTION_LEASE_MINUTES);
  if (!lease) return { ok: false, message: "Scout is syncing with X. Try again in a minute." };
  try {
    const deleted = await deleteXPost(await getXAccessToken(lease, now), pub.xPostId);
    if (!deleted) return { ok: false, message: "X didn't confirm the deletion. Check your profile." };
  } catch (error) {
    return { ok: false, message: error instanceof XApiRequestError ? `X refused: ${error.message.slice(0, 120)}` : "Couldn't reach X. Try again." };
  } finally {
    await releaseXConnection(lease.id);
  }
  await adjustPublishSpend(profile.id, windowStart("month", now), X_PRICING.postDelete);
  await transitionPublication(profile.id, pub.id, ["published"], { deletedAt: now });
  if (pub.draftId) await updateDraft(profile.id, pub.draftId, { publishedConfirmedAt: null, publishedUrl: null });
  return { ok: true };
}

// ---- Scheduler --------------------------------------------------------------------

/**
 * After X didn't answer: looks for the post on the user's own timeline.
 * Found: published. Not found after a few checks: failed (safe to try
 * again), slot and money given back. Never publishes anything itself.
 */
async function reconcile(pub: XPublication, now: Date): Promise<"published" | "failed" | "pending"> {
  const leased = await leaseUnknown(pub.id, now);
  if (!leased) return "pending";
  const profile = await getProfileById(pub.profileId);
  const connection = profile ? await getXConnection(pub.profileId) : undefined;
  const checks = leased.reconcileChecks + 1;
  const give = async (status: "failed", error: string) => {
    if (leased.reservedUsd > 0) await adjustPublishSpend(pub.profileId, windowStart("month", leased.attemptedAt ?? now), -leased.reservedUsd);
    return transitionPublication(pub.profileId, pub.id, ["unknown"], { status, error, claimedUntil: null, windowStart: null, windowSlot: null, reservedUsd: 0, reconcileChecks: checks });
  };
  const lease = connection ? await claimXConnection(pub.profileId, now, CONNECTION_LEASE_MINUTES) : undefined;
  if (!profile || !connection || !lease || (pub.xUserId && pub.xUserId !== connection.xUserId)) {
    if (checks >= MAX_RECONCILE_CHECKS) {
      const moved = await give("failed", "Scout couldn't confirm whether X published it. Check your X profile before trying again.");
      if (moved) await notify(pub.profileId, moved, "A post may not have been published", moved.error);
      return "failed";
    }
    await transitionPublication(pub.profileId, pub.id, ["unknown"], { claimedUntil: null, reconcileChecks: checks });
    return "pending";
  }
  try {
    const token = await getXAccessToken(lease, now);
    const since = new Date((leased.attemptedAt ?? now).getTime() - 2 * 60_000);
    const { posts, returned } = await getOwnRecentPosts(token, connection.xUserId, { since, limit: 10 });
    const target = comparableText(pub.text);
    const found = posts.find((post) => comparableText(post.text) === target);
    if (found) {
      const postUrl = `https://x.com/${connection.handle}/status/${found.id}`;
      const done = await transitionPublication(pub.profileId, pub.id, ["unknown"], {
        status: "published",
        xPostId: found.id,
        publishedAt: leased.attemptedAt ?? now,
        costUsd: leased.reservedUsd,
        claimedUntil: null,
        error: null,
        reconcileChecks: checks,
        reconcileReads: leased.reconcileReads + returned,
      });
      if (pub.draftId) await updateDraft(pub.profileId, pub.draftId, { publishedConfirmedAt: leased.attemptedAt ?? now, publishedUrl: postUrl, status: "ready" });
      if (done) await notify(pub.profileId, done, "Your post is live on X", pub.text.slice(0, 140));
      return "published";
    }
    if (checks >= MAX_RECONCILE_CHECKS) {
      const moved = await give("failed", "X didn't publish it. You can try again.");
      if (moved) {
        await transitionPublication(pub.profileId, pub.id, ["failed"], { reconcileReads: leased.reconcileReads + returned });
        await notify(pub.profileId, moved, "A post didn't publish", "X didn't publish it. You can try again.");
      }
      return "failed";
    }
    await transitionPublication(pub.profileId, pub.id, ["unknown"], { claimedUntil: null, reconcileChecks: checks, reconcileReads: leased.reconcileReads + returned });
    return "pending";
  } catch {
    await transitionPublication(pub.profileId, pub.id, ["unknown"], { claimedUntil: null, reconcileChecks: checks });
    return "pending";
  } finally {
    await releaseXConnection(lease.id);
  }
}

export type PublishingTickResult = { disabled?: true; paused?: true; published: number; failed: number; reconciled: number };

/**
 * Scheduler step (the existing 5-minute cron). Off unless publishing is
 * enabled. In order: in-flight requests whose worker died become "unknown"
 * (never retried blindly); due scheduled posts publish (unless paused);
 * unknown ones are checked on X.
 */
export async function runPublishing({ now = new Date(), limit = 10 } = {}): Promise<PublishingTickResult> {
  const result: PublishingTickResult = { published: 0, failed: 0, reconciled: 0 };
  if (!publishingAvailable()) return { ...result, disabled: true };
  for (const stuck of await expiredPublishing(now, limit)) {
    await transitionPublication(stuck.profileId, stuck.id, ["publishing"], { status: "unknown", claimedUntil: null, error: "X didn't confirm. Scout is checking whether it was published." });
  }
  if (publishingPaused()) result.paused = true;
  else {
    for (const due of await duePublications(now, limit)) {
      const profile = await getProfileById(due.profileId);
      if (!profile) continue;
      const outcome = await publishPublication(profile, due.id, { mode: "scheduled", now });
      if (outcome.ok && outcome.status === "published") result.published++;
      else result.failed++;
    }
  }
  for (const pending of await unknownToReconcile(now, RECONCILE_AFTER_MS, limit)) {
    const outcome = await reconcile(pending, now);
    if (outcome !== "pending") result.reconciled++;
  }
  return result;
}

// ---- Cards ------------------------------------------------------------------------

/** What a publishing card shows, formatted in the user's time zone (Home and Studio share it) */
export function toPublicationCard(
  p: XPublication,
  state: { canPublish: boolean; planAllows: boolean },
  tz: string,
  now = new Date(),
  postUrl: string | null = null,
): PublicationCard {
  const when = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
  return {
    id: p.id,
    draftId: p.draftId,
    status: p.status,
    hasUrl: p.hasUrl,
    scheduledLabel: p.scheduledAt ? when.format(p.scheduledAt) : null,
    error: p.error,
    canPublish: state.canPublish,
    planAllows: state.planAllows,
    postUrl,
    defaultDate: zonedParts(new Date(now.getTime() + 86_400_000), tz).date,
    defaultTime: "09:00",
    timeZone: tz,
  };
}
