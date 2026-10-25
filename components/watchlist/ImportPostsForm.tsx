"use client";

import { useActionState } from "react";

import { importPostsAction, type WatchlistActionState } from "@/actions/watchlist";

export function ImportPostsForm() {
  const [state, formAction, pending] = useActionState<
    WatchlistActionState,
    FormData
  >(importPostsAction, { status: "idle" });

  return (
    <form action={formAction} className="watchlist-import">
      <div>
        <p className="eyebrow">Import posts</p>
        <p className="watchlist-run-copy">
          No X credits? Import a CSV export of a watched account&apos;s posts and Scout
          scans those instead.
        </p>
      </div>
      <input
        // Remount clears the chosen file after each import
        key={state.message ?? "file"}
        type="file"
        name="file"
        accept=".csv,text/csv"
        aria-label="CSV export"
        required
        className="watchlist-file"
      />
      <button type="submit" className="secondary-button" disabled={pending}>
        {pending ? "Importing…" : "Import CSV"}
      </button>
      {state.message && (
        <p className="form-message" data-status={state.status} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
