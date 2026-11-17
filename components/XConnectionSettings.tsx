"use client";

import { useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { disconnectXAction, switchXHandleAction } from "@/actions/xConnection";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const oauthMessages: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "X connected. Your next Growth refresh includes private metrics." },
  cancelled: { ok: false, text: "X connection cancelled." },
  invalid_state: { ok: false, text: "That X link expired or wasn't yours. Try connecting again." },
  missing_scope: { ok: false, text: "X didn't grant the read permissions Scout needs. Try again and allow them." },
  in_use: { ok: false, text: "That X account is already connected to another Scout account." },
  budget: { ok: false, text: "Scout's daily X limit is reached. Try connecting again tomorrow." },
  failed: { ok: false, text: "X connection failed. Try again." },
  not_configured: { ok: false, text: "Connecting X isn't available yet." },
};

export type XConnectionData = {
  enabled: boolean;
  /** The X handle Scout analyzes (profile) */
  profileHandle: string | null;
  autoEveryHours: number | null;
  connection: {
    handle: string;
    status: "active" | "needs_reconnect";
    connectedLabel: string;
    lastCollectedLabel: string | null;
    nextCollectionLabel: string | null;
  } | null;
};

function cadence(hours: number | null): string {
  if (hours === null) return "Manual refresh on Growth, once a day.";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `Scout refreshes automatically every ${days === 1 ? "day" : `${days} days`}, from your plan's X reads. You can also refresh manually.`;
  }
  return `Scout refreshes automatically every ${hours} hours, from your plan's X reads.`;
}

/** Settings: connect or disconnect the user's own X account (OAuth, read-only) */
export function XConnectionSettings({ data }: { data: XConnectionData }) {
  const params = useSearchParams();
  const oauth = oauthMessages[params.get("x") ?? ""];
  const [confirming, setConfirming] = useState(false);
  const [deleteHistory, setDeleteHistory] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const connection = data.connection;
  const notice = message ?? oauth;
  // Shown only for a verified-looking handle from our own callback redirect
  const authorized = params.get("x") === "handle_mismatch" ? params.get("authorized") : null;
  const mismatch = authorized && /^[A-Za-z0-9_]{1,15}$/.test(authorized) && !message ? authorized : null;
  const [switching, setSwitching] = useState(false);
  const [keepHelp, setKeepHelp] = useState(false);

  if (!data.enabled && !connection) return null;

  return (
    <section className="profile-form">
      <div className="form-intro">
        <p className="eyebrow">Growth</p>
        <h2>X analytics</h2>
        <p>
          Connect your X account so Growth Intelligence can show your real impressions, profile clicks and link clicks.
          Read-only: Scout can&apos;t post, like, follow or read your messages.
        </p>
      </div>

      <div>
        <div className="form-fields">
          <div className="field-row">
            <span className="field-label">
              <strong>X account</strong>
              <small>
                {connection
                  ? connection.status === "needs_reconnect"
                    ? "Scout lost access (revoked on X or expired). Connect again."
                    : `Connected ${connection.connectedLabel}${connection.lastCollectedLabel ? ` · last read ${connection.lastCollectedLabel}` : ""}`
                  : "You sign in on X and choose to allow read access. Your Scout login doesn't change."}
              </small>
            </span>
            <div className="notification-inline">
              {connection ? (
                <>
                  <span>@{connection.handle}</span>
                  {connection.status === "needs_reconnect" && data.enabled && (
                    <a className="secondary-button" href="/api/x/oauth/start">
                      Reconnect
                    </a>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => {
                      setDeleteHistory(false);
                      setConfirming(true);
                    }}
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <a className="primary-button" href="/api/x/oauth/start">
                  Connect X
                </a>
              )}
            </div>
          </div>
          <div className="field-row">
            <span className="field-label">
              <strong>Updates</strong>
              <small>
                {cadence(data.autoEveryHours)}
                {connection?.nextCollectionLabel && data.autoEveryHours !== null && ` Next: ${connection.nextCollectionLabel}.`}
              </small>
            </span>
          </div>
        </div>
        {mismatch && (
          <div className="x-mismatch" role="alert">
            <p>
              <strong>
                You authorized @{mismatch} on X, but Scout analyzes {data.profileHandle ? `@${data.profileHandle}` : "another account"}.
              </strong>{" "}
              Which account should Scout use?
            </p>
            <div className="notification-inline">
              <button type="button" className="primary-button" disabled={pending} onClick={() => setSwitching(true)}>
                Use @{mismatch}
              </button>
              <button type="button" className="secondary-button" disabled={pending} onClick={() => setKeepHelp(true)}>
                Keep {data.profileHandle ? `@${data.profileHandle}` : "the current one"}
              </button>
            </div>
            {keepHelp && (
              <p className="memory-note">
                X connects the account you&apos;re signed in to on x.com. Switch to{" "}
                {data.profileHandle ? `@${data.profileHandle}` : "that account"} on{" "}
                <a href="https://x.com" target="_blank" rel="noreferrer">
                  x.com
                </a>{" "}
                (or sign out there), then{" "}
                <a href="/api/x/oauth/start">connect X again</a>.
              </p>
            )}
          </div>
        )}
        {notice && (
          <p className="form-message" data-status={notice.ok ? "success" : "error"} role="status">
            {notice.text}
          </p>
        )}
      </div>

      {mismatch && (
        <ConfirmDialog
          open={switching}
          title={`Use @${mismatch}?`}
          confirmLabel={`Use @${mismatch}`}
          pending={pending}
          onConfirm={() =>
            startTransition(async () => {
              const result = await switchXHandleAction(mismatch);
              if (!result.ok) {
                setMessage({ ok: false, text: result.message });
                setSwitching(false);
                return;
              }
              // X asks once more (usually one click): Scout verifies the account again
              // A route handler that redirects to x.com: needs a full page navigation, not the client router
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.href = "/api/x/oauth/start";
            })
          }
          onCancel={() => setSwitching(false)}
        >
          <ul className="confirm-dialog-list">
            <li>
              Growth Intelligence and future syncs will use @{mismatch}
              {data.profileHandle ? ` instead of @${data.profileHandle}` : ""}.
            </li>
            <li>
              Posts Scout already stored from {data.profileHandle ? `@${data.profileHandle}` : "the previous account"} stay; nothing is
              deleted. Your Scout Brain stays as it is until you rebuild it.
            </li>
            <li>X will ask you to authorize once more, so Scout can verify the account.</li>
          </ul>
        </ConfirmDialog>
      )}
      <ConfirmDialog
        open={confirming}
        title="Disconnect X?"
        confirmLabel="Disconnect"
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            const result = await disconnectXAction({ deleteHistory });
            setMessage({ ok: result.ok, text: result.message });
            setConfirming(false);
          })
        }
        onCancel={() => setConfirming(false)}
      >
        <ul className="confirm-dialog-list">
          <li>Scout revokes its access on X and deletes its tokens.</li>
          <li>Growth goes back to public metrics: profile clicks and link clicks become unavailable.</li>
        </ul>
        <label className="checkbox-row">
          <input type="checkbox" checked={deleteHistory} onChange={(event) => setDeleteHistory(event.target.checked)} />
          Also delete the private metrics Scout already stored
        </label>
      </ConfirmDialog>
    </section>
  );
}
