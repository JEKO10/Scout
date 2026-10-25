"use client";

import { useActionState } from "react";

import {
  addWatchlistAccountAction,
  type WatchlistActionState,
} from "@/actions/watchlist";

export function AddWatchlistAccountForm() {
  const [state, formAction, pending] = useActionState<
    WatchlistActionState,
    FormData
  >(addWatchlistAccountAction, { status: "idle" });

  return (
    <form action={formAction} className="watchlist-add">
      <div className="x-handle-input">
        <span aria-hidden="true">@</span>
        <input
          // Remount clears the field after each successful add
          key={state.status === "success" ? state.message : "input"}
          name="handle"
          placeholder="levelsio"
          aria-label="X handle to watch"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className="field-control"
        />
      </div>
      <button type="submit" className="primary-button" disabled={pending}>
        {pending ? "Adding…" : "+ Add account"}
      </button>
      {state.message && (
        <p className="form-message" data-status={state.status} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
