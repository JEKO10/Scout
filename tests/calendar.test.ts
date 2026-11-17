// Day 32 Content Calendar: time zones (DST, impossible dates), the derived
// lifecycle (missed is never stored, published needs the user), X link
// validation, the month/week grid, the planning assistant, planning and
// rescheduling, missed plans recorded once, and user isolation. No AI or X
// calls; the database is the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { and, eq } from "drizzle-orm";

import db from "@/db";
import { getDraft, getDrafts, getPlannedDrafts, getUnplannedDrafts, insertDraft } from "@/db/queries/content";
import * as s from "@/db/schema";
import {
  calendarDays,
  lifecycle,
  normalizeXPostUrl,
  planningAdvice,
  shiftAnchor,
  weekSummary,
  zonedParts,
  zonedTimeToUtc,
} from "@/lib/content/calendar";
import { noteMissedPlans, planDraft, savePublishedUrl, setArchived, unplanDraft } from "@/services/content/calendar";

import { cleanup, newProfile } from "./helpers/db";

after(cleanup);

const draftFor = (profileId: string, status: "draft" | "ready" = "ready") =>
  insertDraft(profileId, { title: "A post", goal: "educate", format: "post", tone: "bold", length: "short", status, posts: ["Hello"] });

async function events(profileId: string, name: string) {
  const rows = await db
    .select()
    .from(s.analyticsEventsTable)
    .where(and(eq(s.analyticsEventsTable.profileId, profileId), eq(s.analyticsEventsTable.name, name)));
  return rows.length;
}

test("time zones: local time to UTC across DST; impossible dates rejected", () => {
  // Winter (CET, +1) and summer (CEST, +2) in Belgrade
  assert.equal(zonedTimeToUtc("2026-01-15", "09:00", "Europe/Belgrade")?.toISOString(), "2026-01-15T08:00:00.000Z");
  assert.equal(zonedTimeToUtc("2026-07-15", "09:00", "Europe/Belgrade")?.toISOString(), "2026-07-15T07:00:00.000Z");
  assert.equal(zonedTimeToUtc("2026-07-15", "09:00", "America/New_York")?.toISOString(), "2026-07-15T13:00:00.000Z");
  assert.equal(zonedTimeToUtc("2026-11-20", "23:30", "UTC")?.toISOString(), "2026-11-20T23:30:00.000Z");
  // The hour that doesn't exist on the spring change still lands on that day
  const gap = zonedTimeToUtc("2026-03-29", "02:30", "Europe/Belgrade");
  assert.ok(gap && zonedParts(gap, "Europe/Belgrade").date === "2026-03-29");

  assert.equal(zonedTimeToUtc("2026-02-31", "09:00", "UTC"), null);
  assert.equal(zonedTimeToUtc("2026-02-10", "25:00", "UTC"), null);
  assert.equal(zonedTimeToUtc("2026-02-10", "09:00", "Mars/Olympus"), null);

  const back = zonedParts(new Date("2026-07-15T07:00:00Z"), "Europe/Belgrade");
  assert.equal(back.date, "2026-07-15");
  assert.equal(back.time, "09:00");
});

test("lifecycle: missed is derived; published only after the user confirms; archived wins", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const base = { status: "ready" as const, plannedAt: null, publishedConfirmedAt: null, archivedAt: null };
  assert.equal(lifecycle({ ...base, status: "draft" }, now), "draft");
  assert.equal(lifecycle(base, now), "ready");
  assert.equal(lifecycle({ ...base, plannedAt: new Date("2026-11-18T09:00:00Z") }, now), "planned");
  assert.equal(lifecycle({ ...base, plannedAt: new Date("2026-11-16T09:00:00Z") }, now), "missed");
  assert.equal(lifecycle({ ...base, plannedAt: new Date("2026-11-16T09:00:00Z"), publishedConfirmedAt: now }, now), "published");
  assert.equal(lifecycle({ ...base, publishedConfirmedAt: now, archivedAt: now }, now), "archived");
});

test("X links: only status links on x.com / twitter.com, normalized", () => {
  assert.equal(normalizeXPostUrl("https://twitter.com/Someone_1/status/1234567890?s=20"), "https://x.com/Someone_1/status/1234567890");
  assert.equal(normalizeXPostUrl(" https://x.com/a/status/123456789/ "), "https://x.com/a/status/123456789");
  assert.equal(normalizeXPostUrl("http://x.com/a/status/123456789"), null);
  assert.equal(normalizeXPostUrl("https://evil.com/a/status/123456789"), null);
  assert.equal(normalizeXPostUrl("https://x.com.evil.com/a/status/123456789"), null);
  assert.equal(normalizeXPostUrl("https://x.com/a"), null);
  assert.equal(normalizeXPostUrl("javascript:alert(1)"), null);
});

test("calendar grid: Monday-first weeks, whole weeks per month", () => {
  const nov = calendarDays("2026-11-17", "month");
  assert.equal(nov[0], "2026-10-26", "November 2026 starts on a Sunday: the grid starts the Monday before");
  assert.equal(nov.length % 7, 0);
  assert.ok(nov.includes("2026-11-30"));
  const week = calendarDays("2026-11-17", "week");
  assert.deepEqual([week[0], week[6]], ["2026-11-16", "2026-11-22"]);
  assert.equal(shiftAnchor("2026-01-31", "month", 1), "2026-02-01");
  assert.equal(shiftAnchor("2026-12-28", "week", 1), "2027-01-04");
});

test("planning assistant: deterministic suggestions from the plan, no posting times", () => {
  const item = (goal: s.ContentDraft["goal"], state: "planned" | "missed" = "planned") => ({ goal, lifecycle: state, sourceTrendId: null });
  const promo = weekSummary([item("promote_product"), item("promote_product"), item("generate_leads"), item("educate", "missed")], []);
  assert.equal(promo.missed, 1);
  const advice = planningAdvice(promo, 2, ["AI agents"]);
  assert.ok(advice.some((line) => line.includes("missed")));
  assert.ok(advice.some((line) => line.includes("promotional")));
  assert.ok(advice.some((line) => line.includes("conversation")));
  assert.ok(advice.some((line) => line.includes("AI agents")));
  assert.ok(!advice.some((line) => /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|best time/i.test(line)), "no posting-time advice");

  const empty = planningAdvice(weekSummary([], []), 1, []);
  assert.ok(empty[0].includes("ready"));
});

test("plan, reschedule, unplan, archive: stored in UTC, events recorded, nothing posted", async () => {
  const p = await newProfile();
  const draft = await draftFor(p.id);

  assert.equal((await planDraft(p, draft.id, { date: "2026-02-31", time: "09:00", timeZone: "UTC" })).ok, false);
  assert.equal((await planDraft(p, draft.id, { date: "2030-01-10", time: "09:00", timeZone: "Nope/Zone" })).ok, false);

  assert.ok((await planDraft(p, draft.id, { date: "2030-07-10", time: "09:00", timeZone: "Europe/Belgrade", note: "launch week" })).ok);
  let row = await getDraft(p.id, draft.id);
  assert.equal(row?.plannedAt?.toISOString(), "2030-07-10T07:00:00.000Z");
  assert.equal(row?.timeZone, "Europe/Belgrade");
  assert.equal(row?.planNote, "launch week");
  assert.equal(row?.publishedConfirmedAt, null, "planning never marks it posted");
  assert.equal(await events(p.id, "content_planned"), 1);

  assert.ok((await planDraft(p, draft.id, { date: "2030-07-11", time: "18:15", timeZone: "UTC", goal: "start_conversations" })).ok);
  row = await getDraft(p.id, draft.id);
  assert.equal(row?.plannedAt?.toISOString(), "2030-07-11T18:15:00.000Z");
  assert.equal(row?.goal, "start_conversations");
  assert.equal(await events(p.id, "content_rescheduled"), 1);

  const range = await getPlannedDrafts(p.id, new Date("2030-07-01T00:00:00Z"), new Date("2030-08-01T00:00:00Z"));
  assert.deepEqual(range.map((d) => d.id), [draft.id]);
  assert.equal((await getUnplannedDrafts(p.id)).length, 0);

  assert.ok((await unplanDraft(p, draft.id)).ok);
  row = await getDraft(p.id, draft.id);
  assert.equal(row?.plannedAt, null);
  assert.ok(row, "the draft is kept");
  assert.equal((await getUnplannedDrafts(p.id)).length, 1);

  assert.ok((await setArchived(p, draft.id, true)).ok);
  assert.equal((await getDrafts(p.id)).length, 0, "archived drafts leave Studio");
  assert.equal((await getDrafts(p.id, { archived: true })).length, 1);
  assert.equal((await getUnplannedDrafts(p.id)).length, 0);
  assert.ok((await setArchived(p, draft.id, false)).ok);
  assert.equal((await getDrafts(p.id)).length, 1);
});

test("published link: validated, counts as the user's confirmation", async () => {
  const p = await newProfile();
  const draft = await draftFor(p.id);
  assert.equal((await savePublishedUrl(p, draft.id, "https://example.com/post")).ok, false);
  assert.equal((await getDraft(p.id, draft.id))?.publishedConfirmedAt, null);

  assert.ok((await savePublishedUrl(p, draft.id, "https://twitter.com/me/status/1234567890")).ok);
  const row = await getDraft(p.id, draft.id);
  assert.equal(row?.publishedUrl, "https://x.com/me/status/1234567890");
  assert.ok(row?.publishedConfirmedAt);
  assert.equal(await events(p.id, "content_published_url_saved"), 1);

  assert.ok((await savePublishedUrl(p, draft.id, "")).ok);
  assert.equal((await getDraft(p.id, draft.id))?.publishedUrl, null);
});

test("missed plans: recorded once; a new date clears it; confirmed posts never count", async () => {
  const p = await newProfile();
  const missed = await draftFor(p.id);
  const posted = await draftFor(p.id);
  const future = await draftFor(p.id);
  await planDraft(p, missed.id, { date: "2026-01-05", time: "09:00", timeZone: "UTC" });
  await planDraft(p, posted.id, { date: "2026-01-05", time: "10:00", timeZone: "UTC" });
  await planDraft(p, future.id, { date: "2035-01-05", time: "09:00", timeZone: "UTC" });
  await savePublishedUrl(p, posted.id, "https://x.com/me/status/1234567890");

  assert.equal(await noteMissedPlans(p.id), 1);
  assert.equal(await noteMissedPlans(p.id), 0, "not recorded twice");
  assert.equal(await events(p.id, "content_plan_missed"), 1);
  const row = await getDraft(p.id, missed.id);
  assert.equal(row && lifecycle(row), "missed");
  assert.equal(row?.status, "ready", "the stored status doesn't change");

  await planDraft(p, missed.id, { date: "2026-02-05", time: "09:00", timeZone: "UTC" });
  assert.equal(await noteMissedPlans(p.id), 1, "a new past date can be missed again");
});

test("isolation: no one plans, links or sees another user's drafts", async () => {
  const owner = await newProfile();
  const other = await newProfile();
  const draft = await draftFor(owner.id);
  await planDraft(owner, draft.id, { date: "2030-03-03", time: "09:00", timeZone: "UTC" });

  assert.equal((await planDraft(other, draft.id, { date: "2030-03-04", time: "09:00", timeZone: "UTC" })).ok, false);
  assert.equal((await unplanDraft(other, draft.id)).ok, false);
  assert.equal((await setArchived(other, draft.id, true)).ok, false);
  assert.equal((await savePublishedUrl(other, draft.id, "https://x.com/me/status/1234567890")).ok, false);
  assert.equal((await getPlannedDrafts(other.id, new Date("2030-01-01"), new Date("2031-01-01"))).length, 0);
  assert.equal(await noteMissedPlans(other.id), 0);

  const row = await getDraft(owner.id, draft.id);
  assert.equal(row?.plannedAt?.toISOString(), "2030-03-03T09:00:00.000Z");
  assert.equal(row?.archivedAt, null);
  assert.equal(row?.publishedUrl, null);
});
