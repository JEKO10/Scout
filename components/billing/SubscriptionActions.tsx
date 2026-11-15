"use client";

import { useState, useTransition } from "react";

import { cancelSubscriptionAction, keepSubscriptionAction } from "@/actions/billing";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Cancel at the end of the period (with confirmation), or undo a scheduled
 * cancellation. Everything else (card, invoices) lives in Manage billing.
 */
export function SubscriptionActions({
  planLabel,
  scheduledEndLabel,
  periodEndLabel,
  canCancel,
}: {
  planLabel: string;
  /** Set when a cancellation is already scheduled */
  scheduledEndLabel: string | null;
  periodEndLabel: string | null;
  canCancel: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message?: string }>, onDone?: () => void) {
    startTransition(async () => {
      setError(null);
      setMessage(null);
      const result = await action();
      if (!result.ok) {
        if (confirming) setError(result.message ?? "Something went wrong.");
        else setMessage({ ok: false, text: result.message ?? "Something went wrong." });
        return;
      }
      onDone?.();
      setMessage({ ok: true, text: result.message ?? "Done." });
    });
  }

  return (
    <>
      {scheduledEndLabel ? (
        <button type="button" className="secondary-button" disabled={pending} onClick={() => run(keepSubscriptionAction)}>
          {pending ? "Saving…" : "Keep my subscription"}
        </button>
      ) : (
        canCancel && (
          <button
            type="button"
            className="text-link plan-cancel-link"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            Cancel subscription
          </button>
        )
      )}
      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Cancel ${planLabel}?`}
        confirmLabel="Cancel subscription"
        pending={pending}
        error={error}
        onConfirm={() => run(cancelSubscriptionAction, () => setConfirming(false))}
        onCancel={() => setConfirming(false)}
      >
        <ul className="confirm-dialog-list">
          <li>
            <strong>
              You keep {planLabel} until {periodEndLabel ?? "the end of this billing period"}.
            </strong>{" "}
            Then your account moves to Free.
          </li>
          <li>Nothing is deleted: your watchlist, Scout Brain and history stay. Free limits apply after that date.</li>
          <li>You can change your mind until then with &quot;Keep my subscription&quot;.</li>
        </ul>
      </ConfirmDialog>
    </>
  );
}
