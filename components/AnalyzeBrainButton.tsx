"use client";

import { useActionState } from "react";

import { analyzeBrainAction, type BrainActionState } from "@/actions/brain";

export function AnalyzeBrainButton({ analyzed }: { analyzed: boolean }) {
  const [state, formAction, pending] = useActionState<BrainActionState>(
    analyzeBrainAction,
    { status: "idle" },
  );

  return (
    <form action={formAction} className="brain-analyze">
      <button
        type="submit"
        className={analyzed ? "secondary-button" : "primary-button"}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <span className="x-sync-spinner" aria-hidden="true" />
            Analyzing your posts…
          </>
        ) : analyzed ? (
          "Re-analyze"
        ) : (
          "Build my Scout Brain"
        )}
      </button>
      {state.message && !pending && (
        <p className="form-message" data-status={state.status} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
