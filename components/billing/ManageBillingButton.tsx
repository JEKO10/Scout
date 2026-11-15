"use client";

import { useState, useTransition } from "react";

import { openBillingPortalAction } from "@/actions/billing";

/** Opens Paddle's customer portal with a link made on demand (they expire quickly) */
export function ManageBillingButton() {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const result = await openBillingPortalAction();
            if (result.ok && result.url) window.location.assign(result.url);
            else setMessage(result.ok ? "Couldn't open billing." : result.message);
          })
        }
      >
        {pending ? "Opening…" : "Manage billing"}
      </button>
      {message && (
        <p className="form-message" data-status="error" role="status">
          {message}
        </p>
      )}
    </>
  );
}
