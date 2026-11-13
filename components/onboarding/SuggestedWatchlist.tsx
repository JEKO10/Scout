"use client";

import { useState, useTransition } from "react";

import { addSuggestedAccountsAction } from "@/actions/onboarding";
import type { SuggestedAccount } from "@/lib/onboarding/suggestedAccounts";

/**
 * Ideas matched to the user's topics. Nothing is pre-picked: adding one is a
 * choice (each is looked up on X, like any watchlist account).
 */
export function SuggestedWatchlist({ accounts }: { accounts: SuggestedAccount[] }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (accounts.length === 0) return null;

  function toggle(handle: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  }

  function add() {
    setMessage(null);
    startTransition(async () => {
      const result = await addSuggestedAccountsAction([...chosen]);
      if (!result.ok) {
        setMessage("Couldn't add those accounts. Try again.");
        return;
      }
      setChosen(new Set());
      setMessage(
        `Added ${result.added} ${result.added === 1 ? "account" : "accounts"}.` +
          (result.skipped.length ? ` Skipped: ${result.skipped.map((h) => `@${h}`).join(", ")}.` : ""),
      );
    });
  }

  return (
    <div className="suggested-block">
      <p className="eyebrow">Ideas based on your topics</p>
      <ul className="suggested-accounts">
        {accounts.map((account) => (
          <li key={account.handle}>
            <label>
              <input type="checkbox" checked={chosen.has(account.handle)} onChange={() => toggle(account.handle)} />
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
      <div className="calibration-actions">
        <button type="button" className="secondary-button" disabled={pending || chosen.size === 0} onClick={add}>
          {pending ? "Adding…" : chosen.size ? `Add ${chosen.size} selected` : "Select accounts to add"}
        </button>
      </div>
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
