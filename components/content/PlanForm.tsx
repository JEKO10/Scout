"use client";

import { useState, useTransition } from "react";

import { archiveDraftAction, planDraftAction, unplanDraftAction } from "@/actions/content";
import { CONTENT_GOALS, type ContentGoal, GOAL_LABEL } from "@/lib/content/types";

/** Time zones offered; the user's current one is always added */
const COMMON_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Belgrade",
  "Europe/Podgorica",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
];

/**
 * Give a draft a planned date and time (in a chosen time zone). Planning
 * only: the user still posts it on X themselves.
 */
export function PlanForm({
  draftId,
  initial,
  compact = false,
}: {
  draftId: string;
  initial: { date: string; time: string; timeZone: string; goal: ContentGoal; note: string; planned: boolean; archived?: boolean };
  compact?: boolean;
}) {
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [goal, setGoal] = useState(initial.goal);
  const [note, setNote] = useState(initial.note);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const zones = COMMON_ZONES.includes(initial.timeZone) ? COMMON_ZONES : [initial.timeZone, ...COMMON_ZONES];

  function run(task: () => Promise<{ ok: boolean; message?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await task();
      setMessage(result.message ? { ok: result.ok, text: result.message } : result.ok ? null : { ok: false, text: "Something went wrong." });
    });
  }

  return (
    <div className="plan-form" aria-busy={pending}>
      <div className="plan-fields">
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={pending} required />
        </label>
        <label>
          Time
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={pending} required />
        </label>
        <label>
          Time zone
          <select value={timeZone} onChange={(e) => setTimeZone(e.target.value)} disabled={pending}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        {!compact && (
          <label>
            Goal
            <select value={goal} onChange={(e) => setGoal(e.target.value as ContentGoal)} disabled={pending}>
              {CONTENT_GOALS.map((option) => (
                <option key={option} value={option}>
                  {GOAL_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!compact && (
        <label className="plan-note">
          Note (only you see it)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={pending} />
        </label>
      )}
      <div className="topic-actions">
        <button type="button" disabled={pending || !date || !time} onClick={() => run(() => planDraftAction(draftId, { date, time, timeZone, goal, note }))}>
          {initial.planned ? "Save new date" : "Plan it"}
        </button>
        {initial.planned && (
          <button type="button" disabled={pending} onClick={() => run(() => unplanDraftAction(draftId))}>
            Remove from calendar
          </button>
        )}
        {!compact && (
          <button type="button" disabled={pending} onClick={() => run(() => archiveDraftAction(draftId, !initial.archived))}>
            {initial.archived ? "Unarchive" : "Archive"}
          </button>
        )}
      </div>
      <p className="memory-note">Planning only: Scout never posts for you. At that time, open the draft and post it on X.</p>
      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
