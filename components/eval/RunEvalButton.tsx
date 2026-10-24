"use client";

import { useActionState } from "react";

import { type EvalActionState, runEvalAction } from "@/actions/eval";

export function RunEvalButton({ hasRun }: { hasRun: boolean }) {
  const [state, formAction, pending] = useActionState<EvalActionState>(
    runEvalAction,
    { status: "idle" },
  );

  return (
    <form action={formAction} className="brain-analyze">
      <button
        type="submit"
        className={hasRun ? "secondary-button" : "primary-button"}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <span className="x-sync-spinner" aria-hidden="true" />
            Generating replies…
          </>
        ) : hasRun ? (
          "Run eval again"
        ) : (
          "Run eval"
        )}
      </button>
      {pending && (
        <p className="form-message" data-status="idle">
          This takes about a minute.
        </p>
      )}
      {state.message && !pending && (
        <p className="form-message" data-status={state.status} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
