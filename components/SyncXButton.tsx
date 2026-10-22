"use client";

import { useActionState } from "react";

import { syncXAccountAction, type SyncXState } from "@/actions/x";

export function SyncXButton({ synced }: { synced: boolean }) {
  const [state, formAction, pending] = useActionState<SyncXState>(
    syncXAccountAction,
    { status: "idle" },
  );

  return (
    <form action={formAction} className="x-sync">
      <button
        type="submit"
        className={synced ? "secondary-button" : "primary-button"}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <span className="x-sync-spinner" aria-hidden="true" />
            Syncing…
          </>
        ) : synced ? (
          "Sync again"
        ) : (
          "Sync X account"
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
