import Image from "next/image";
import Link from "next/link";

import type { SocialAccount } from "@/db/schema";

import { SyncXButton } from "./SyncXButton";

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function XAccountCard({
  handle,
  account,
  postCount,
}: {
  handle: string | null;
  account: SocialAccount | undefined;
  postCount: number;
}) {
  const synced = Boolean(account?.lastSyncedAt);

  return (
    <div className="aside-section x-account">
      <div className="aside-heading">
        <p className="eyebrow">X account</p>
        {account && (
          <a
            href={`https://x.com/${account.handle}`}
            target="_blank"
            rel="noreferrer"
            className="x-account-link"
          >
            View on X <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>

      {handle ? (
        <>
          <div className="x-account-identity">
            {account?.avatarUrl ? (
              <Image
                src={account.avatarUrl}
                alt=""
                width={40}
                height={40}
                className="x-account-avatar"
              />
            ) : (
              <span className="avatar-placeholder x-account-avatar" aria-hidden="true">
                {handle.charAt(0).toUpperCase()}
              </span>
            )}
            <div>
              <strong>{account?.displayName ?? `@${handle}`}</strong>
              <span>@{account?.handle ?? handle}</span>
            </div>
          </div>

          <div className="status-line">
            <span className="live-dot" data-active={synced || undefined} />
            <div>
              <strong>{synced ? "Connected" : "Not synced"}</strong>
              <p>
                {synced && account?.lastSyncedAt
                  ? `${postCount} posts imported · Last synced ${formatRelative(account.lastSyncedAt)}`
                  : "Import your recent posts so Scout can learn your voice."}
              </p>
            </div>
          </div>

          <SyncXButton synced={synced} />
        </>
      ) : (
        <>
          <p className="aside-empty">
            Add your X handle so Scout can learn how you write.
          </p>
          <Link href="/account/settings" className="text-link">
            Add X handle <span aria-hidden="true">→</span>
          </Link>
        </>
      )}
    </div>
  );
}

function formatRelative(date: Date) {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");

  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");

  return relativeTime.format(Math.round(hours / 24), "day");
}
