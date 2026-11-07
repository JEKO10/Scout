"use client";

import { useState, useTransition } from "react";

import { finishOnboardingAction } from "@/actions/onboarding";
import type { SuggestedAccount } from "@/lib/onboarding/suggestedAccounts";

export function SuggestedWatchlist({
  accounts,
  preselected,
}: {
  accounts: SuggestedAccount[];
  preselected: number;
}) {
  const [chosen, setChosen] = useState(
    () => new Set(accounts.slice(0, preselected).map((account) => account.handle)),
  );
  const [pending, startTransition] = useTransition();

  function toggle(handle: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  }

  function finish(handles: string[]) {
    startTransition(() => finishOnboardingAction(handles));
  }

  return (
    <div className="calibration">
      <p className="eyebrow">Suggested watchlist</p>
      <p className="calibration-prompt">
        Accounts that post about what you care about. Pick the ones Scout should follow;
        you can change this any time.
      </p>

      {accounts.length ? (
        <ul className="suggested-accounts">
          {accounts.map((account) => (
            <li key={account.handle}>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.has(account.handle)}
                  onChange={() => toggle(account.handle)}
                />
                <span>
                  <strong>@{account.handle}</strong>
                  <small>
                    {account.name} · {account.tags.slice(0, 4).join(", ")}
                  </small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="memory-note">
          No suggestions match your topics yet. Add accounts yourself on the Watchlist page.
        </p>
      )}

      <div className="calibration-actions">
        <button
          type="button"
          className="primary-button"
          disabled={pending}
          onClick={() => finish([...chosen])}
        >
          {pending
            ? "Finishing…"
            : chosen.size
              ? `Add ${chosen.size} ${chosen.size === 1 ? "account" : "accounts"} and finish`
              : "Finish"}
        </button>
        {chosen.size > 0 && (
          <button
            type="button"
            className="text-link calibration-skip"
            disabled={pending}
            onClick={() => finish([])}
          >
            Skip, I&apos;ll add my own
          </button>
        )}
      </div>
    </div>
  );
}
