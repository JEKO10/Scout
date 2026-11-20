"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteAccountAction } from "@/actions/account";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Settings: delete the account and its data, after typing DELETE. Also retries a deletion that stopped. */
export function DeleteAccount({ retry = false }: { retry?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      setMessage(null);
      const result = await deleteAccountAction("DELETE");
      if (result.ok) {
        router.replace("/account-deleted");
        return;
      }
      setMessage(result.message);
      if (result.status === "needs_attention") router.replace("/account-deleted");
    });

  if (retry) {
    return (
      <div className="inbox-inline">
        <button type="button" className="primary-button" onClick={run} disabled={pending}>
          {pending ? "Deleting…" : "Try again"}
        </button>
        {message && (
          <small className="form-message" data-status="error" role="alert">
            {message}
          </small>
        )}
      </div>
    );
  }

  return (
    <section className="profile-form">
      <div className="form-intro">
        <p className="eyebrow">Account</p>
        <h2>Delete account</h2>
        <p>
          Deletes your Scout account and the data stored with it, revokes Scout&apos;s access to your X account and cancels
          scheduled posts. Posts already published on X stay on X. This can&apos;t be undone.
        </p>
      </div>
      <div>
        <button type="button" className="secondary-button" onClick={() => setOpen(true)} disabled={pending}>
          {pending ? "Deleting…" : "Delete my account"}
        </button>
        <div aria-live="polite">
          {message && (
            <p className="form-message" data-status="error" role="alert">
              {message}
            </p>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={open}
        title="Delete your Scout account?"
        confirmLabel="Delete account"
        onCancel={() => {
          setOpen(false);
          setConfirmation("");
        }}
        onConfirm={() => {
          if (confirmation !== "DELETE") {
            setMessage("Type DELETE to confirm.");
            return;
          }
          setOpen(false);
          setConfirmation("");
          run();
        }}
      >
        <p>Your data in Scout is deleted and can&apos;t be recovered. If you have a paid plan, cancel it first.</p>
        <label className="about-field">
          <span>Type DELETE to confirm</span>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
        </label>
      </ConfirmDialog>
    </section>
  );
}
