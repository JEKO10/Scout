"use client";

import { useState, useTransition } from "react";

import {
  editReplyAction,
  generateRepliesAction,
  markReplyCopiedAction,
} from "@/actions/replies";
import type { Reply } from "@/db/schema";
import { REPLY_STYLE_INFO, REPLY_STYLES, type ReplyStyle } from "@/lib/replies/styles";

export type DraftReply = Pick<Reply, "id" | "variant" | "content" | "originalContent" | "status">;

const X_LIMIT = 280;

/**
 * Generate Reply and the two drafts it produces, in two styles the user picks
 * first (one AI call either way). Copy puts the text on the clipboard (the
 * user posts on X themselves) and marks the opportunity replied.
 */
export function ReplyDrafts({
  opportunityId,
  initial,
  defaultStyles,
  onCopied,
}: {
  opportunityId: string;
  initial: DraftReply[];
  /** The user's last pick, so they rarely need to choose again */
  defaultStyles: ReplyStyle[];
  onCopied: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftReply[]>(initial);
  const [styles, setStyles] = useState<ReplyStyle[]>(
    initial.length === 2 ? initial.map((draft) => draft.variant) : defaultStyles,
  );
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [remember, setRemember] = useState(false);
  const [generating, startGenerating] = useTransition();
  const hasDrafts = drafts.length > 0;

  function generate() {
    setError(null);
    startGenerating(async () => {
      const result = await generateRepliesAction(opportunityId, {
        styles,
        instruction,
        remember,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDrafts(result.replies);
      setInstruction("");
      setRemember(false);
    });
  }

  const ready = styles.length === 2 && !generating;
  const errorMessage = error && (
    <p className="form-message" data-status="error" role="status">
      {error}
    </p>
  );

  if (!hasDrafts) {
    return (
      <div className="reply-generate">
        <StylePicker value={styles} onChange={setStyles} disabled={generating} />
        <button type="button" className="primary-button" disabled={!ready} onClick={generate}>
          {generating ? (
            <>
              <span className="x-sync-spinner" aria-hidden="true" />
              Generating…
            </>
          ) : (
            "Generate Reply"
          )}
        </button>
        {errorMessage}
      </div>
    );
  }

  return (
    <div className="reply-drafts" aria-busy={generating}>
      {drafts.map((draft) => (
        <DraftVariant
          key={draft.id}
          label={REPLY_STYLE_INFO[draft.variant].label}
          reply={draft}
          onCopied={onCopied}
        />
      ))}
      <form
        className="reply-regenerate"
        onSubmit={(event) => {
          event.preventDefault();
          generate();
        }}
      >
        <StylePicker value={styles} onChange={setStyles} disabled={generating} />
        <input
          className="field-control"
          value={instruction}
          maxLength={300}
          placeholder="What should change? e.g. shorter, no agreeing opener"
          aria-label="What should change in the next drafts (optional)"
          onChange={(event) => setInstruction(event.target.value)}
        />
        <button type="submit" className="secondary-button" disabled={!ready}>
          {generating ? (
            <>
              <span className="x-sync-spinner" aria-hidden="true" />
              Regenerating…
            </>
          ) : (
            "Regenerate"
          )}
        </button>
        {instruction.trim() && (
          <label className="reply-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Always do this (save as a rule for every reply)
          </label>
        )}
        {errorMessage}
      </form>
    </div>
  );
}

/** Pick exactly two styles; picking a third replaces the older pick. */
function StylePicker({
  value,
  onChange,
  disabled,
}: {
  value: ReplyStyle[];
  onChange: (styles: ReplyStyle[]) => void;
  disabled: boolean;
}) {
  function toggle(style: ReplyStyle) {
    if (value.includes(style)) onChange(value.filter((picked) => picked !== style));
    else onChange([...value, style].slice(-2));
  }

  return (
    <fieldset className="reply-styles" disabled={disabled}>
      <legend>
        Pick 2 styles <span>({value.length}/2)</span>
      </legend>
      <div>
        {REPLY_STYLES.map((style) => (
          <button
            key={style}
            type="button"
            className="reply-style"
            aria-pressed={value.includes(style)}
            title={REPLY_STYLE_INFO[style].hint}
            onClick={() => toggle(style)}
          >
            {REPLY_STYLE_INFO[style].label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function DraftVariant({
  label,
  reply,
  onCopied,
}: {
  label: string;
  reply: DraftReply;
  onCopied: () => void;
}) {
  const [content, setContent] = useState(reply.content);
  const [draft, setDraft] = useState(reply.content);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(reply.status === "approved");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const edited = content !== reply.originalContent;

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await editReplyAction(reply.id, draft);
      if (!result.ok) {
        setMessage(result.message ?? "Couldn't save.");
        return;
      }
      setContent(draft.trim());
      setEditing(false);
    });
  }

  async function copy() {
    setMessage(null);
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      setMessage("Couldn't copy. Select the text and copy it manually.");
      return;
    }
    setCopied(true);
    onCopied();
    startTransition(async () => {
      await markReplyCopiedAction(reply.id);
    });
  }

  const length = (editing ? draft : content).length;

  return (
    <section className="reply-variant">
      <header>
        <h3>{label}</h3>
        <span className="reply-meta">
          {edited && <span>Edited ·</span>}
          <span data-over={length > X_LIMIT || undefined}>
            {length}/{X_LIMIT}
          </span>
        </span>
      </header>

      {editing ? (
        <textarea
          className="field-control reply-editor"
          value={draft}
          rows={4}
          autoFocus
          aria-label={`Edit ${label} reply`}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <p className="reply-text">{content}</p>
      )}

      <div className="reply-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="primary-button"
              disabled={pending || !draft.trim()}
              onClick={save}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={() => {
                setDraft(content);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="primary-button" onClick={copy}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </>
        )}
      </div>
      {message && (
        <p className="form-message" data-status="error" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
