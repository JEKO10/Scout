"use client";

import { useState, useTransition } from "react";

import { refreshGrowthAction } from "@/actions/growth";

/** One explicit click: re-reads the newest posts and follower count from X (uses plan X reads) */
export function RefreshGrowthButton({
  posts,
  disabledReason,
  description,
}: {
  posts: number;
  disabledReason: string | null;
  description?: string;
}) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="growth-refresh">
      <button
        type="button"
        className="secondary-button"
        disabled={pending || Boolean(disabledReason)}
        onClick={() =>
          startTransition(async () => {
            const result = await refreshGrowthAction();
            setMessage({ ok: result.ok, text: result.message });
          })
        }
      >
        {pending ? "Refreshing…" : "Refresh from X"}
      </button>
      <small>{disabledReason ?? description ?? `Reads your ${posts} newest posts and follower count. Uses up to ${posts} of your plan's X reads; once a day.`}</small>
      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
