// Day 25 beta feedback: stored per user, validated, rate limited, and the
// analytics event never carries the message. Database: the isolated test branch.
import "./setup/env";

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { and, eq } from "drizzle-orm";

import db from "@/db";
import * as s from "@/db/schema";
import { submitFeedback } from "@/services/feedback/submit";

import { cleanup, newProfile } from "./helpers/db";

after(cleanup);

test("feedback is stored for its user, validated and rate limited", async () => {
  const a = await newProfile();
  const b = await newProfile();

  const sent = await submitFeedback(a.id, { category: "bug", message: "  The scan button spins forever  ", path: "/dashboard" });
  assert.equal(sent.ok, true);
  const [row] = await db.select().from(s.feedbackTable).where(eq(s.feedbackTable.profileId, a.id));
  assert.equal(row.category, "bug");
  assert.equal(row.message, "The scan button spins forever");
  assert.equal(row.path, "/dashboard");

  // The message is optional; invalid input is refused
  assert.equal((await submitFeedback(a.id, { category: "general" })).ok, true);
  assert.equal((await submitFeedback(a.id, { category: "spam" as "bug" })).ok, false);
  assert.equal((await submitFeedback(a.id, { category: "general", message: "x".repeat(2001) })).ok, false);
  assert.equal((await submitFeedback(a.id, { category: "general", path: "/x?token=secret" })).ok, false);

  // Third in ten minutes is fine, the fourth is refused; other users aren't affected
  assert.equal((await submitFeedback(a.id, { category: "feature" })).ok, true);
  const limited = await submitFeedback(a.id, { category: "feature" });
  assert.equal(limited.ok, false);
  assert.equal((await submitFeedback(b.id, { category: "general" })).ok, true);

  // Analytics: the category, never the text
  const events = await db
    .select()
    .from(s.analyticsEventsTable)
    .where(and(eq(s.analyticsEventsTable.profileId, a.id), eq(s.analyticsEventsTable.name, "feedback_submitted")));
  assert.equal(events.length, 3);
  for (const event of events) assert.deepEqual(Object.keys(event.props ?? {}), ["category"]);
});
