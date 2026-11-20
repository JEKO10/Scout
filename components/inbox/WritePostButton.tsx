"use client";

import { useState, useTransition } from "react";

import { inboxWritePostAction } from "@/actions/inbox";

/** "Write me a post": one draft now, from the writing budget; the user asked for it */
export function WritePostButton({ primary = false, quiet = false }: { primary?: boolean; quiet?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="inbox-inline">
      <button
        type="button"
        className={primary ? "primary-button" : quiet ? "inbox-ghost" : "secondary-button"}
        disabled={pending}
        aria-busy={pending}
        title="Uses your writing budget"
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const result = await inboxWritePostAction();
            if (!result.ok) setMessage(result.message);
            else if (result.already) setMessage("A post is already waiting for you above.");
          })
        }
      >
        {pending ? "Writing…" : "Prepare a post"}
      </button>
      {message && (
        <small className="inbox-why" role="status">
          {message}
        </small>
      )}
    </span>
  );
}
