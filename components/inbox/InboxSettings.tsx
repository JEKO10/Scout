"use client";

import { useState, useTransition } from "react";

import { resetInboxLearningAction, setAutoPrepareAction } from "@/actions/inbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export type InboxSettingsData = {
  /** INBOX_AUTO_PREPARE_ENABLED: off until approved for this deployment */
  available: boolean;
  enabled: boolean;
  /** Ceilings per window, from the plan */
  posts: number;
  replies: number;
  window: "day" | "week" | "month";
  /** Most automatic preparation may spend in a month, USD */
  monthlyCapUsd: number;
  learned: string[];
};

/** Settings: automatic preparation (opt-in) and what Scout learned from the Inbox (resettable) */
export function InboxSettings({ data }: { data: InboxSettingsData }) {
  const [enabled, setEnabled] = useState(data.enabled);
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section className="profile-form">
      <div className="form-intro">
        <p className="eyebrow">Home</p>
        <h2>Prepared for you</h2>
        <p>Scout puts the work worth doing on Home. You approve or decline it; nothing is posted for you.</p>
      </div>
      <div>
        <fieldset className="sensitivity-options" disabled={pending || !data.available}>
          <legend className="sr-only">Automatic preparation</legend>
          <label className="sensitivity-option">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                const next = event.target.checked;
                setEnabled(next);
                startTransition(async () => {
                  const result = await setAutoPrepareAction(next);
                  if (!result.ok) setEnabled(!next);
                });
              }}
            />
            <span>
              <strong>Automatically prepare content for me.</strong>
              <small>
                Scout uses part of your existing AI writing allowance (up to ${data.monthlyCapUsd.toFixed(2)} a month) to prepare up to{" "}
                {data.posts} post{data.posts === 1 ? "" : "s"}
                {data.replies ? ` and ${data.replies} repl${data.replies === 1 ? "y" : "ies"}` : ""} a {data.window}, only when there&apos;s
                something worth it. The rest stays for what you ask for. Nothing is published without your approval.
              </small>
              {!data.available && <small>Not available yet. Until then, tap “Write me a post” or “Write reply” on Home.</small>}
            </span>
          </label>
        </fieldset>
        <p className="memory-note">
          <strong>What Scout learned</strong>
          <br />
          {data.learned.length ? data.learned.join(" ") : "Nothing yet. Scout learns from what you approve, edit and decline."}
        </p>
        {data.learned.length > 0 && (
          <button type="button" className="secondary-button" onClick={() => setConfirmReset(true)} disabled={pending}>
            Reset what Scout learned
          </button>
        )}
        <div aria-live="polite">{message && <p className="form-message" data-status="success">{message}</p>}</div>
      </div>
      <ConfirmDialog
        open={confirmReset}
        title="Reset what Scout learned?"
        confirmLabel="Reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          startTransition(async () => {
            await resetInboxLearningAction();
            setMessage("Done. Scout starts learning again from now.");
          });
        }}
      >
        <p>Scout forgets the preferences it learned from your Home decisions. Your Scout Brain and reply rules don&apos;t change.</p>
      </ConfirmDialog>
    </section>
  );
}
