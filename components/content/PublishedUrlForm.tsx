"use client";

import { useState, useTransition } from "react";

import { savePublishedUrlAction } from "@/actions/content";

/**
 * Optional: the link to the post on X after the user posted it. Saving a
 * link counts as the user confirming it's posted; Scout doesn't check X.
 */
export function PublishedUrlForm({ draftId, initial }: { draftId: string; initial: string }) {
  const [url, setUrl] = useState(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="plan-form"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        startTransition(async () => {
          const result = await savePublishedUrlAction(draftId, url);
          setMessage({ ok: result.ok, text: result.message ?? (result.ok ? "Saved." : "Something went wrong.") });
        });
      }}
    >
      <label className="plan-note">
        Link to the post on X (optional, after you posted it)
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://x.com/you/status/…"
          maxLength={300}
          disabled={pending}
        />
      </label>
      <div className="topic-actions">
        <button type="submit" disabled={pending || url.trim() === initial}>
          {url.trim() ? "Save link" : "Remove link"}
        </button>
      </div>
      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}
    </form>
  );
}
