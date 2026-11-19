"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { inboxDecideRevisionAction, inboxReviseAction, inboxSaveTextAction } from "@/actions/inbox";
import { countXChars, X_POST_LIMIT } from "@/lib/content/types";
import { QUICK_EDIT_LABEL, QUICK_EDITS } from "@/lib/inbox/types";

type Preview = { revisionId: string; text: string; warning: string | null };

const AUTOSAVE_MS = 800;

/**
 * Inline editor: type and it saves itself; Undo steps back; four one-click
 * AI edits and one plain instruction, each shown as a preview first. The
 * user's own text is never overwritten without "Use this".
 */
export function InboxEditor({
  itemKey,
  initialText,
  onChange,
  onApprove,
  onClose,
  approving,
}: {
  itemKey: string;
  initialText: string;
  onChange: (text: string) => void;
  onApprove: () => void;
  onClose: () => void;
  approving: boolean;
}) {
  const [text, setText] = useState(initialText);
  const [history, setHistory] = useState<string[]>([]);
  const [saved, setSaved] = useState<"saved" | "saving" | "error" | null>(null);
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, startAsking] = useTransition();
  const lastSaved = useRef(initialText);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function save(value: string) {
    if (value.trim() === lastSaved.current.trim() || !value.trim()) return true;
    setSaved("saving");
    const result = await inboxSaveTextAction(itemKey, value);
    if (result.ok) {
      lastSaved.current = value;
      setSaved("saved");
      return true;
    }
    setSaved("error");
    setError(result.message);
    return false;
  }

  useEffect(() => {
    onChange(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(text), AUTOSAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  function edit(value: string) {
    // One undo step per pause in typing, not per keystroke
    if (history.at(-1) !== lastSaved.current) setHistory((h) => [...h, lastSaved.current].slice(-20));
    setText(value);
  }

  function undo() {
    const previous = history.at(-1);
    if (previous === undefined) return;
    setHistory((h) => h.slice(0, -1));
    setText(previous);
  }

  function ask(request: { type: "quick"; edit: string } | { type: "custom"; instruction: string }) {
    setError(null);
    startAsking(async () => {
      const result = await inboxReviseAction(itemKey, request, text);
      if (!result.ok) return setError(result.message);
      setPreview({ revisionId: result.revisionId, text: result.text, warning: result.warning });
      if (request.type === "custom") setInstruction("");
    });
  }

  function resolve(accept: boolean) {
    if (!preview) return;
    const chosen = preview;
    setPreview(null);
    if (accept) {
      setHistory((h) => [...h, text].slice(-20));
      // The server applies it; the autosave then has nothing new to write
      lastSaved.current = chosen.text;
      setText(chosen.text);
    }
    void inboxDecideRevisionAction(chosen.revisionId, accept).then((result) => {
      if (!result.ok) setError(result.message);
    });
  }

  const chars = countXChars(text);

  return (
    <div className="inbox-editor">
      <label className="sr-only" htmlFor={`edit-${itemKey}`}>
        Edit the draft
      </label>
      <textarea
        id={`edit-${itemKey}`}
        className="inbox-textarea"
        value={text}
        rows={5}
        onChange={(event) => edit(event.target.value)}
        autoFocus
      />
      <div className="inbox-editor-meta">
        <span data-over={chars > X_POST_LIMIT || undefined}>
          {chars}/{X_POST_LIMIT}
        </span>
        <span aria-live="polite">{saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : saved === "error" ? "Not saved" : ""}</span>
        <button type="button" className="inbox-ghost" onClick={undo} disabled={history.length === 0}>
          Undo
        </button>
      </div>

      {preview ? (
        <div className="inbox-preview" aria-live="polite">
          <p className="inbox-why">Scout&apos;s version</p>
          <p className="inbox-text">{preview.text}</p>
          {preview.warning && <p className="inbox-warning">{preview.warning}</p>}
          <div className="inbox-actions">
            <button type="button" className="primary-button" onClick={() => resolve(true)}>
              Use this
            </button>
            <button type="button" className="inbox-ghost" onClick={() => resolve(false)}>
              Keep original
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="inbox-chips" role="group" aria-label="Quick AI edits">
            {QUICK_EDITS.map((key) => (
              <button key={key} type="button" className="inbox-chip" disabled={asking} onClick={() => ask({ type: "quick", edit: key })}>
                {QUICK_EDIT_LABEL[key]}
              </button>
            ))}
          </div>
          <form
            className="inbox-ask"
            onSubmit={(event) => {
              event.preventDefault();
              if (instruction.trim()) ask({ type: "custom", instruction });
            }}
          >
            <label className="sr-only" htmlFor={`ask-${itemKey}`}>
              Tell Scout what to change
            </label>
            <input
              id={`ask-${itemKey}`}
              value={instruction}
              maxLength={300}
              placeholder="Tell Scout what to change..."
              onChange={(event) => setInstruction(event.target.value)}
            />
            <button type="submit" className="secondary-button" disabled={asking || !instruction.trim()}>
              {asking ? "…" : "Go"}
            </button>
          </form>
          {asking && <p className="inbox-why" aria-live="polite">Scout is rewriting it…</p>}
        </>
      )}

      {error && (
        <p className="form-message" data-status="error" role="alert">
          {error}
        </p>
      )}

      <div className="inbox-actions">
        <button
          type="button"
          className="primary-button"
          disabled={approving || Boolean(preview)}
          onClick={async () => {
            if (await save(text)) onApprove();
          }}
        >
          {approving ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          className="inbox-ghost"
          onClick={async () => {
            if (await save(text)) onClose();
          }}
        >
          Save draft
        </button>
      </div>
    </div>
  );
}
