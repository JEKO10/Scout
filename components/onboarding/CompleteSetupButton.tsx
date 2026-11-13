"use client";

import { useState, useTransition } from "react";

import { completeOnboardingAction } from "@/actions/onboarding";

/** Accounts step → first scan. The server checks the essentials again. */
export function CompleteSetupButton({ ready }: { ready: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="calibration-actions">
      <button
        type="button"
        className="primary-button"
        disabled={!ready || pending}
        onClick={() =>
          startTransition(async () => {
            const result = await completeOnboardingAction();
            if (result && !result.ok) setMessage(result.message ?? "Something went wrong.");
          })
        }
      >
        {pending ? "Saving…" : "Continue"}
      </button>
      {!ready && <small className="memory-note">Add at least one account to continue.</small>}
      {message && (
        <p className="form-message" data-status="error" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
