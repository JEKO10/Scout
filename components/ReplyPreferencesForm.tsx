"use client";

import { useState, useTransition } from "react";

import { saveReplyPreferencesAction } from "@/actions/replyPreferences";
import type { PreferenceConflict, ReplyPreferences } from "@/lib/scout/replyPreferences";

const lines = (text: string) => text.split("\n");

/**
 * Settings: what the user wants to reply to, and what not. Separate from the
 * Scout Brain (what they know) and from its low-confidence topics (what the
 * Brain isn't sure about).
 */
export function ReplyPreferencesForm({
  initial,
  conflicts,
}: {
  initial: ReplyPreferences;
  /** Computed on the server from the saved values */
  conflicts: PreferenceConflict[];
}) {
  const [want, setWant] = useState(initial.want.join("\n"));
  const [avoid, setAvoid] = useState(initial.avoid.join("\n"));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveReplyPreferencesAction({ want: lines(want), avoid: lines(avoid) });
      setMessage({ ok: result.ok, text: result.message });
    });
  }

  return (
    <section className="profile-form">
      <div className="form-intro">
        <p className="eyebrow">Reply preferences</p>
        <h2>What you want to reply to</h2>
        <p>
          Your Brain knows what you know. This tells Scout which conversations you actually want to
          join. One per line, a few words each. Rebuilding your Brain never changes these.
        </p>
      </div>

      <div>
        <div className="form-fields">
          <label className="field-row">
            <span className="field-label">
              <strong>I want to reply to</strong>
              <small>e.g. takes and predictions about AI coding</small>
            </span>
            <textarea
              className="field-control"
              rows={5}
              value={want}
              onChange={(event) => setWant(event.target.value)}
              placeholder={"takes and predictions about AI coding\nmodel comparisons from real use"}
            />
          </label>
          <label className="field-row">
            <span className="field-label">
              <strong>Not for me</strong>
              <small>Topics you don&apos;t want to reply to. Not the same as topics the Brain is unsure about.</small>
            </span>
            <textarea
              className="field-control"
              rows={5}
              value={avoid}
              onChange={(event) => setAvoid(event.target.value)}
              placeholder={"newsletter tool promos\nfollower milestones"}
            />
          </label>
        </div>

        {conflicts.length > 0 && (
          <div className="preference-conflicts" role="status">
            <strong>These may hide posts you want</strong>
            <ul>
              {conflicts.map((conflict) => (
                <li key={`${conflict.source}:${conflict.avoid}`}>
                  &ldquo;{conflict.avoid}&rdquo;
                  {conflict.source === "avoidTopics" ? " (from your profile's topics to avoid)" : ""}{" "}
                  {conflict.reason === "too_broad" ? "is broad enough to cover" : "overlaps with"}{" "}
                  {conflict.conflictsWith.slice(0, 4).join(", ")}.
                </li>
              ))}
            </ul>
            <small>Nothing was changed. Make the entry more specific if it hides what you want.</small>
          </div>
        )}

        <div className="form-footer">
          <div aria-live="polite">
            {message && (
              <p className="form-message" data-status={message.ok ? "success" : "error"}>
                {message.text}
              </p>
            )}
          </div>
          <button type="button" className="primary-button" disabled={pending} onClick={save}>
            Save preferences
          </button>
        </div>
      </div>
    </section>
  );
}
