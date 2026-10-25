"use client";

import Image from "next/image";
import { useOptimistic, useTransition } from "react";

import {
  removeWatchlistAccountAction,
  setWatchlistAccountActiveAction,
} from "@/actions/watchlist";
import type { WatchlistAccount } from "@/db/schema";

type Account = Pick<
  WatchlistAccount,
  "id" | "handle" | "displayName" | "avatarUrl" | "isActive"
> & { unverified: boolean };

type Change =
  | { type: "toggle"; id: string; isActive: boolean }
  | { type: "remove"; id: string };

export function WatchlistList({ accounts }: { accounts: Account[] }) {
  const [items, applyChange] = useOptimistic(accounts, (current, change: Change) =>
    change.type === "remove"
      ? current.filter((account) => account.id !== change.id)
      : current.map((account) =>
          account.id === change.id ? { ...account, isActive: change.isActive } : account,
        ),
  );
  const [, startTransition] = useTransition();

  if (items.length === 0) {
    return (
      <p className="watchlist-empty">
        No accounts yet. Start with 10–20 people whose posts you&apos;d genuinely
        want to reply to.
      </p>
    );
  }

  return (
    <ul className="watchlist-list">
      {items.map((account) => (
        <li key={account.id} data-paused={!account.isActive || undefined}>
          {account.avatarUrl ? (
            <Image
              src={account.avatarUrl}
              alt=""
              width={36}
              height={36}
              className="x-account-avatar"
            />
          ) : (
            <span className="avatar-placeholder" aria-hidden="true">
              {account.handle.charAt(0).toUpperCase()}
            </span>
          )}

          <div className="watchlist-identity">
            <a href={`https://x.com/${account.handle}`} target="_blank" rel="noreferrer">
              @{account.handle}
            </a>
            <span>
              {account.displayName ??
                (account.unverified ? "Not verified yet" : "X account")}
            </span>
          </div>

          <span className="watchlist-status" data-active={account.isActive || undefined}>
            {account.isActive ? "Active" : "Paused"}
          </span>

          <button
            type="button"
            className="secondary-button watchlist-toggle"
            onClick={() =>
              startTransition(async () => {
                applyChange({ type: "toggle", id: account.id, isActive: !account.isActive });
                await setWatchlistAccountActiveAction(account.id, !account.isActive);
              })
            }
          >
            {account.isActive ? "Pause" : "Resume"}
          </button>

          <button
            type="button"
            className="eval-delete"
            aria-label={`Remove @${account.handle}`}
            title="Remove"
            onClick={() =>
              startTransition(async () => {
                applyChange({ type: "remove", id: account.id });
                await removeWatchlistAccountAction(account.id);
              })
            }
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
