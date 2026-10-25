"use client";

import { useState, useTransition } from "react";

import {
  editReplyAction,
  generateRepliesAction,
  markReplyCopiedAction,
} from "@/actions/replies";
import type { Reply } from "@/db/schema";

export type DraftReply = Pick<Reply, "id" | "variant" | "content" | "originalContent" | "status">;
export type DraftPair = { natural?: DraftReply; strongerTake?: DraftReply };

const X_LIMIT = 280;

/**
 * Generate Reply and the two drafts it produces. Copy puts the text on the
 * clipboard (the user posts on X themselves) and marks the opportunity replied.
 */
export function ReplyDrafts({
  opportunityId,
  initial,
  onCopied,
}: {
  opportunityId: string;
  initial: DraftPair;
  onCopied: () => void;
}) {
  const [pair, setPair] = useState<DraftPair>(initial);
  const [error, setError] = useState<string | null>(null);
  const [generating, startGenerating] = useTransition();
  const hasDrafts = Boolean(pair.natural || pair.strongerTake);

  function generate() {
    setError(null);
    startGenerating(async () => {
      const result = await generateRepliesAction(opportunityId);
      if (result.ok) setPair(result.replies);
      else setError(result.message);
    });
  }

  if (!hasDrafts) {
    return (
      <div className="reply-generate">
        <button
          type="button"
          className="primary-button"
          disabled={generating}
          onClick={generate}
        >
          {generating ? (
            <>
              <span className="x-sync-spinner" aria-hidden="true" />
              Generating…
            </>
          ) : (
            "Generate Reply"
          )}
        </button>
        {error && (
          <p className="form-message" data-status="error" role="status">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="reply-drafts" aria-busy={generating}>
      {pair.natural && (
        <DraftVariant
          key={pair.natural.id}
          label="Natural"
          reply={pair.natural}
          onCopied={onCopied}
        />
      )}
      {pair.strongerTake && (
        <DraftVariant
          key={pair.strongerTake.id}
          label="Stronger take"
          reply={pair.strongerTake}
          onCopied={onCopied}
        />
      )}
      <div className="reply-regenerate">
        <button
          type="button"
          className="secondary-button"
          disabled={generating}
          onClick={generate}
        >
          {generating ? (
            <>
              <span className="x-sync-spinner" aria-hidden="true" />
              Regenerating…
            </>
          ) : (
            "Regenerate"
          )}
        </button>
        {error && (
          <p className="form-message" data-status="error" role="status">
            {error}
          </p>
        )}
      </div>
    </div>
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
