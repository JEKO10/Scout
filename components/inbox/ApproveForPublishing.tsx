"use client";

import { useState, useTransition } from "react";

import { approveForPublishingAction } from "@/actions/publishing";

/** Studio: approve the draft's saved text for publishing on X (the exact text, nothing else) */
export function ApproveForPublishing({ draftId }: { draftId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="inbox-inline">
      <button
        type="button"
        className="primary-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const result = await approveForPublishingAction(draftId);
            if (!result.ok) setMessage(result.message);
          })
        }
      >
        {pending ? "Approving…" : "Approve for publishing"}
      </button>
      <small className="inbox-why">Approves the saved text exactly as it is. Changing it later means approving again.</small>
      {message && (
        <small className="form-message" data-status="error" role="alert">
          {message}
        </small>
      )}
    </div>
  );
}
