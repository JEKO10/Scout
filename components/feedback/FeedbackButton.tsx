"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { submitFeedbackAction } from "@/actions/feedback";

const CATEGORIES = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature request" },
  { value: "general", label: "General feedback" },
] as const;

type Category = (typeof CATEGORIES)[number]["value"];

/** Header: "Feedback" opens a small form; sent with the page it came from */
export function FeedbackButton() {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>("general");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function close() {
    if (pending) return;
    setOpen(false);
    // A fresh form next time, once something was sent
    if (result?.ok) {
      setMessage("");
      setCategory("general");
      setResult(null);
    }
  }

  function send() {
    startTransition(async () => {
      setResult(null);
      const response = await submitFeedbackAction({
        category,
        message: message.trim() || undefined,
        // Read at send time: no router hook, so the header stays static
        path: window.location.pathname,
      }).catch(() => ({ ok: false, message: "Couldn't send. Check your connection and try again." }));
      setResult({ ok: response.ok, text: response.message });
    });
  }

  return (
    <>
      <button type="button" className="feedback-trigger" onClick={() => setOpen(true)}>
        Feedback
      </button>
      <dialog
        ref={ref}
        className="confirm-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="confirm-dialog-panel">
          <h2 id={titleId}>Send feedback</h2>
          {result?.ok ? (
            <p className="form-message" data-status="success" role="status">
              {result.text}
            </p>
          ) : (
            <>
              <fieldset className="feedback-categories" disabled={pending}>
                <legend className="sr-only">Type of feedback</legend>
                {CATEGORIES.map((option) => (
                  <label key={option.value} data-selected={category === option.value || undefined}>
                    <input
                      type="radio"
                      name="feedback-category"
                      value={option.value}
                      checked={category === option.value}
                      onChange={() => setCategory(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </fieldset>
              <label className="feedback-message">
                <span>What happened, or what would help? (optional)</span>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  maxLength={2000}
                  rows={5}
                  disabled={pending}
                  placeholder={category === "bug" ? "What did you do, what did you expect, what happened?" : ""}
                />
              </label>
              {result && (
                <p className="form-message" data-status="error" role="alert">
                  {result.text}
                </p>
              )}
            </>
          )}
          <div className="confirm-dialog-actions">
            <button type="button" className="secondary-button" onClick={close} disabled={pending}>
              {result?.ok ? "Close" : "Cancel"}
            </button>
            {!result?.ok && (
              <button type="button" className="primary-button" onClick={send} disabled={pending}>
                {pending ? "Sending…" : "Send feedback"}
              </button>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
