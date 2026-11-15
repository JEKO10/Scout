"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";

/**
 * A modal confirmation built on <dialog>: focus is trapped, Escape and the
 * backdrop cancel, and the page behind can't be clicked while it's open.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby={titleId}
      // Escape: cancel, unless the action is already running
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      // A click on the backdrop (the dialog element itself, outside the panel)
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div className="confirm-dialog-panel">
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-dialog-body">{children}</div>
        {error && (
          <p className="form-message" data-status="error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={onConfirm} disabled={pending} autoFocus>
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
