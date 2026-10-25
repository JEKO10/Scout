"use client";

import Link from "next/link";
import { useActionState } from "react";

import { runScoutAction, type WatchlistActionState } from "@/actions/watchlist";

export function RunScoutButton({ disabled }: { disabled: boolean }) {
  const [state, formAction, pending] = useActionState<WatchlistActionState>(
    runScoutAction,
    { status: "idle" },
  );

  return (
    <form action={formAction} className="watchlist-run-form">
      <button
        type="submit"
        className="primary-button"
        disabled={disabled || pending}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <span className="x-sync-spinner" aria-hidden="true" />
            Scanning and scoring…
          </>
        ) : (
          "Run Scout"
        )}
      </button>

      {!pending && state.run && (
        <div className="run-result" role="status">
          <p>
            <strong>{state.run.analyzed}</strong> posts analyzed ·{" "}
            <strong>{state.run.opportunities}</strong>{" "}
            {state.run.opportunities === 1 ? "opportunity" : "opportunities"} found
          </p>
          <Link href="/opportunities" className="text-link">
            View opportunities <span aria-hidden="true">→</span>
          </Link>
        </div>
      )}
      {!pending && state.message && (
        <p className="form-message" data-status={state.status}>
          {state.message}
        </p>
      )}
    </form>
  );
}
