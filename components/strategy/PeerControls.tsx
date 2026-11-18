"use client";

import { useState, useTransition } from "react";

import { addPeerAction, refreshPeerAction, removePeerAction, setPeerSelectedAction } from "@/actions/strategy";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Message = { ok: boolean; text: string } | null;

function Notice({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
      {message.text}
    </p>
  );
}

/** Add an account by handle: one X lookup for its public profile */
export function AddPeerForm({ disabled }: { disabled: boolean }) {
  const [handle, setHandle] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="peer-add"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await addPeerAction(handle, "manual");
          setMessage({ ok: result.ok, text: result.message });
          if (result.ok) setHandle("");
        });
      }}
    >
      <input
        type="text"
        value={handle}
        placeholder="@account you admire"
        maxLength={16}
        onChange={(event) => setHandle(event.target.value)}
        aria-label="X handle"
        disabled={disabled || pending}
      />
      <button type="submit" className="secondary-button" disabled={disabled || pending || handle.trim().length < 2}>
        {pending ? "Looking up…" : "Add account"}
      </button>
      <Notice message={message} />
    </form>
  );
}

export function AddSuggestionButton({ handle, source }: { handle: string; source: "watchlist" | "scans" }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <button
        type="button"
        className="text-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await addPeerAction(handle, source);
            setMessage(result.ok ? null : { ok: false, text: result.message });
          })
        }
      >
        {pending ? "Adding…" : "Add"}
      </button>
      <Notice message={message} />
    </>
  );
}

/** Select for "My selected accounts", refresh (when enabled), remove */
export function PeerRowControls({
  peerId,
  handle,
  selected,
  refreshEnabled,
}: {
  peerId: string;
  handle: string;
  selected: boolean;
  refreshEnabled: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="task-controls">
      <label className="peer-select">
        <input
          type="checkbox"
          checked={selected}
          disabled={pending}
          onChange={(event) =>
            startTransition(async () => {
              const result = await setPeerSelectedAction(peerId, event.target.checked);
              setMessage(result.ok ? null : { ok: false, text: result.message });
            })
          }
        />
        Selected
      </label>
      {refreshEnabled && (
        <button
          type="button"
          className="text-button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await refreshPeerAction(peerId);
              setMessage({ ok: result.ok, text: result.message });
            })
          }
        >
          Read recent posts
        </button>
      )}
      <button type="button" className="text-button" disabled={pending} onClick={() => setConfirming(true)}>
        Remove
      </button>
      <Notice message={message} />
      <ConfirmDialog
        open={confirming}
        title={`Remove @${handle}?`}
        confirmLabel="Remove"
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            const result = await removePeerAction(peerId);
            setMessage(result.ok ? null : { ok: false, text: result.message });
            setConfirming(false);
          })
        }
        onCancel={() => setConfirming(false)}
      >
        <p>Scout stops comparing with this account and deletes the numbers it kept about its posts. Plans already made don&apos;t change.</p>
      </ConfirmDialog>
    </div>
  );
}
