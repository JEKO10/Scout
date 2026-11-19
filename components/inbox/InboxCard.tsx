"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { inboxActAction, inboxDecideRevisionAction, inboxDeclineReasonAction, inboxReviseAction } from "@/actions/inbox";
import { recordReplyIntentAction } from "@/actions/replyIntents";
import { DECLINE_LABEL, DECLINE_REASONS, type InboxItem } from "@/lib/inbox/types";

import { InboxEditor } from "./InboxEditor";

type Preview = { revisionId: string; text: string; warning: string | null };
type Mode = "view" | "edit" | "approved" | "feedback" | "gone";

/**
 * One Inbox card: a short label, the prepared result, one sentence of why,
 * one primary action and as few others as make sense for the item.
 */
export function InboxCard({ item }: { item: InboxItem }) {
  const router = useRouter();
  const [text, setText] = useState(item.text);
  const [mode, setMode] = useState<Mode>("view");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<{ text: string; copyText?: string; openUrl?: string | null; opportunityId?: string; replyId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  const editable = item.type === "post" || item.type === "reply";

  function act(action: string, then?: (result: { outcome: string; copyText?: string; openUrl?: string | null; opportunityId?: string; replyId?: string }) => void) {
    setError(null);
    setBusy(action);
    startTransition(async () => {
      const result = await inboxActAction(item.key, action);
      setBusy(null);
      if (!result.ok) return setError(result.message);
      then?.(result);
    });
  }

  const approve = () =>
    act("approve", (result) => {
      setOutcome({ text: result.outcome, copyText: result.copyText, openUrl: result.openUrl, opportunityId: result.opportunityId, replyId: result.replyId });
      setMode("approved");
    });
  // Declined / dismissed: gone at once; the reason is optional
  const decline = (action: "decline" | "dismiss") => act(action, () => setMode("feedback"));

  function regenerate() {
    setError(null);
    setBusy("regenerate");
    startTransition(async () => {
      const result = await inboxReviseAction(item.key, { type: "regenerate" }, text);
      setBusy(null);
      if (!result.ok) return setError(result.message);
      setPreview({ revisionId: result.revisionId, text: result.text, warning: result.warning });
    });
  }

  function resolvePreview(accept: boolean) {
    if (!preview) return;
    const chosen = preview;
    setPreview(null);
    if (accept) setText(chosen.text);
    startTransition(async () => {
      const result = await inboxDecideRevisionAction(chosen.revisionId, accept);
      if (!result.ok) setError(result.message);
    });
  }

  function close() {
    setMode("gone");
    router.refresh();
  }

  /** An approved reply copied or opened on X: the existing Day 21 record ("reply opened", never "posted") */
  function recordIntent(source: "clipboard" | "x_web_intent") {
    if (!outcome?.opportunityId || !outcome.copyText) return;
    void recordReplyIntentAction({ opportunityId: outcome.opportunityId, replyId: outcome.replyId ?? null, text: outcome.copyText, source });
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      recordIntent("clipboard");
    } catch {
      setError("Couldn't copy. Select the text and copy it yourself.");
    }
  }

  if (mode === "gone") return null;

  if (mode === "feedback") {
    return (
      <article className="inbox-card inbox-card-compact" aria-live="polite">
        <p className="inbox-why">Got it. Why wasn&apos;t this useful? (optional)</p>
        <div className="inbox-chips">
          {DECLINE_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              className="inbox-chip"
              onClick={() => {
                void inboxDeclineReasonAction(item.key, reason);
                close();
              }}
            >
              {DECLINE_LABEL[reason]}
            </button>
          ))}
          <button type="button" className="inbox-chip inbox-chip-quiet" onClick={close} aria-label="Skip feedback">
            Skip
          </button>
        </div>
      </article>
    );
  }

  if (mode === "approved" && outcome) {
    return (
      <article className="inbox-card inbox-card-compact" aria-live="polite">
        <p className="inbox-done">✓ {outcome.text}</p>
        <p className="inbox-text inbox-text-small">{outcome.copyText ?? text}</p>
        <div className="inbox-actions">
          {outcome.copyText && (
            <button type="button" className="primary-button" onClick={() => copy(outcome.copyText!)}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {outcome.openUrl && (
            <a className="secondary-button" href={outcome.openUrl} target="_blank" rel="noreferrer" onClick={() => recordIntent("x_web_intent")}>
              {item.type === "reply" ? "Reply on X" : "Post on X"} ↗
            </a>
          )}
          <button type="button" className="inbox-ghost" onClick={close}>
            Close
          </button>
        </div>
        {error && <p className="form-message" data-status="error">{error}</p>}
      </article>
    );
  }

  return (
    <article className="inbox-card" data-type={item.type} aria-busy={pending}>
      <p className="inbox-label">{item.label}</p>

      {item.type === "reply" && item.context && (
        <p className="inbox-context">
          {item.context.author ? `@${item.context.author}: ` : ""}
          {item.context.text}
        </p>
      )}
      {(item.type === "conversation" || item.type === "lead") && item.context?.author && <p className="inbox-author">@{item.context.author}</p>}

      {mode === "edit" ? (
        <InboxEditor
          itemKey={item.key}
          initialText={text}
          onChange={setText}
          onApprove={approve}
          onClose={() => setMode("view")}
          approving={busy === "approve"}
        />
      ) : preview ? (
        <div className="inbox-preview" aria-live="polite">
          <p className="inbox-why">Here&apos;s another version.</p>
          <p className="inbox-text">{preview.text}</p>
          {preview.warning && <p className="inbox-warning">{preview.warning}</p>}
          <div className="inbox-actions">
            <button type="button" className="primary-button" onClick={() => resolvePreview(true)}>
              Use this
            </button>
            <button
              type="button"
              className="inbox-ghost"
              disabled={pending}
              onClick={() => {
                // The rejected version stays in the history; ask for another
                void inboxDecideRevisionAction(preview.revisionId, false);
                setPreview(null);
                regenerate();
              }}
            >
              {busy === "regenerate" ? "Writing…" : "Try again"}
            </button>
            <button type="button" className="inbox-ghost" onClick={() => resolvePreview(false)}>
              Keep original
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="inbox-text">{text}</p>
          <p className="inbox-why">{item.why}</p>
          <div className="inbox-actions">
            {editable && (
              <>
                <button type="button" className="primary-button" onClick={approve} disabled={pending}>
                  {busy === "approve" ? "Approving…" : "Approve"}
                </button>
                <button type="button" className="inbox-ghost" onClick={() => setMode("edit")} disabled={pending}>
                  Edit
                </button>
                <button type="button" className="inbox-ghost" onClick={regenerate} disabled={pending}>
                  {busy === "regenerate" ? "Writing…" : "Regenerate"}
                </button>
                <button type="button" className="inbox-ghost" onClick={() => decline("decline")} disabled={pending}>
                  Decline
                </button>
              </>
            )}
            {item.type === "conversation" && (
              <>
                <button type="button" className="primary-button" onClick={() => act("write_reply", () => router.refresh())} disabled={pending}>
                  {busy === "write_reply" ? "Writing…" : "Write reply"}
                </button>
                <button type="button" className="inbox-ghost" onClick={() => act("save")} disabled={pending}>
                  Save
                </button>
                <button type="button" className="inbox-ghost" onClick={() => decline("dismiss")} disabled={pending}>
                  Dismiss
                </button>
              </>
            )}
            {item.type === "lead" && (
              <>
                <button type="button" className="primary-button" onClick={() => act("save")} disabled={pending}>
                  {busy === "save" ? "Saving…" : "Save lead"}
                </button>
                <button type="button" className="inbox-ghost" onClick={() => act("dismiss")} disabled={pending}>
                  Dismiss
                </button>
              </>
            )}
            {item.type === "recommendation" && (
              <>
                <button type="button" className="primary-button" onClick={() => act("accept")} disabled={pending}>
                  Accept
                </button>
                <button type="button" className="inbox-ghost" onClick={() => act("dismiss")} disabled={pending}>
                  Dismiss
                </button>
              </>
            )}
            {item.type === "reminder" && (
              <>
                <button type="button" className="primary-button" onClick={() => act("done")} disabled={pending}>
                  Done
                </button>
                <button type="button" className="inbox-ghost" onClick={() => act("snooze")} disabled={pending}>
                  Tomorrow
                </button>
              </>
            )}
            {item.externalUrl && (item.type === "conversation" || item.type === "reply") ? (
              <a className="inbox-link" href={item.externalUrl} target="_blank" rel="noreferrer">
                View ↗
              </a>
            ) : item.href && item.type !== "post" && item.type !== "reply" ? (
              <a className="inbox-link" href={item.href}>
                {item.type === "lead" ? "Details" : "Open"}
              </a>
            ) : null}
          </div>
        </>
      )}
      {error && (
        <p className="form-message" data-status="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
