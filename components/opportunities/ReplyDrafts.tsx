"use client";

import { useState, useTransition } from "react";

import { editReplyAction, generateRepliesAction } from "@/actions/replies";
import { recordReplyIntentAction } from "@/actions/replyIntents";
import type { Reply } from "@/db/schema";
import { REPLY_STYLE_INFO, REPLY_STYLES, type ReplyStyle } from "@/lib/replies/styles";
import { checkReplyText, normalizeReplyText, replyIntentUrl, X_REPLY_LIMIT } from "@/lib/replies/xIntent";

export type DraftReply = Pick<Reply, "id" | "variant" | "content" | "originalContent" | "status">;

/**
 * Generate Reply and the two drafts it produces, in two styles the user picks
 * first (one AI call either way). The user picks a draft, edits it, and
 * replies on X in X's own composer (Day 21): Scout never posts.
 */
export function ReplyDrafts({
  opportunityId,
  postId,
  postUrl,
  initial,
  defaultStyles,
  onReplyOpened,
}: {
  opportunityId: string;
  /** The original X post's ID, for the reply composer */
  postId: string;
  postUrl: string | null;
  initial: DraftReply[];
  /** The user's last pick, so they rarely need to choose again */
  defaultStyles: ReplyStyle[];
  onReplyOpened: () => void;
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
      {/* Regenerating replaces the drafts: a fresh composer for the new ones */}
      <ReplyComposer
        key={drafts.map((draft) => draft.id).join()}
        opportunityId={opportunityId}
        postId={postId}
        postUrl={postUrl}
        drafts={drafts}
        onReplyOpened={onReplyOpened}
      />
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

/**
 * Pick a draft, edit it, reply on X. Edits are kept per draft while switching.
 * "Reply on X" is a real link: the browser opens X's composer on the click
 * itself (no popup blocker), and Scout records the attempt alongside it.
 */
function ReplyComposer({
  opportunityId,
  postId,
  postUrl,
  drafts,
  onReplyOpened,
}: {
  opportunityId: string;
  postId: string;
  postUrl: string | null;
  drafts: DraftReply[];
  onReplyOpened: () => void;
}) {
  const [selected, setSelected] = useState(drafts[0]?.id ?? "");
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(drafts.map((draft) => [draft.id, draft.content])),
  );
  const [saved, setSaved] = useState<Record<string, string>>(() =>
    Object.fromEntries(drafts.map((draft) => [draft.id, draft.content])),
  );
  const [tracking, setTracking] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const draft = drafts.find((item) => item.id === selected) ?? drafts[0];
  const text = texts[draft.id] ?? "";
  const check = checkReplyText(text);
  const intentUrl = replyIntentUrl(postId, text);
  const edited = normalizeReplyText(text) !== draft.originalContent.trim();

  // Keep edits on the draft (as Edit → Save did), quietly, when leaving the box
  function persist() {
    const value = normalizeReplyText(text);
    if (!value || value === saved[draft.id]) return;
    startTransition(async () => {
      const result = await editReplyAction(draft.id, value);
      if (result.ok) setSaved((previous) => ({ ...previous, [draft.id]: value }));
    });
  }

  function track(source: "x_web_intent" | "clipboard") {
    setTracking("saving");
    setMessage(null);
    startTransition(async () => {
      const result = await recordReplyIntentAction({ opportunityId, replyId: draft.id, text, source });
      if (result.ok) {
        setTracking("saved");
        onReplyOpened();
      } else {
        setTracking("failed");
        setMessage(result.message ?? "Couldn't save this to your Activity.");
      }
    });
  }

  async function copyAndOpen() {
    if (!check.ok) return;
    // Opened in the click itself, before anything async, so it isn't blocked
    if (postUrl) window.open(postUrl, "_blank", "noopener,noreferrer");
    try {
      await navigator.clipboard.writeText(normalizeReplyText(text));
    } catch {
      setMessage("Couldn't copy. Select the text and copy it manually.");
      return;
    }
    track("clipboard");
  }

  return (
    <section className="reply-composer" aria-busy={pending}>
      <fieldset className="reply-choices">
        <legend className="sr-only">Pick a draft</legend>
        {drafts.map((item) => (
          <label key={item.id} className="reply-choice" data-selected={item.id === draft.id || undefined}>
            <input
              type="radio"
              name={`draft-${opportunityId}`}
              checked={item.id === draft.id}
              onChange={() => setSelected(item.id)}
            />
            <span>
              <strong>{REPLY_STYLE_INFO[item.variant].label}</strong>
              {texts[item.id] !== item.originalContent && <small> · edited</small>}
              <span className="reply-choice-text">{texts[item.id]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="reply-variant">
        <header>
          <h3>Your reply</h3>
          <span className="reply-meta">
            {edited && <span>Edited ·</span>}
            <span data-over={check.length > X_REPLY_LIMIT || undefined} aria-live="polite">
              {check.length}/{X_REPLY_LIMIT}
            </span>
          </span>
        </header>
        <textarea
          className="field-control reply-editor"
          value={text}
          rows={5}
          aria-label="Your reply"
          onChange={(event) => {
            setTexts((previous) => ({ ...previous, [draft.id]: event.target.value }));
            if (tracking === "saved") setTracking("idle");
          }}
          onBlur={persist}
        />
      </label>

      <div className="reply-actions">
        <a
          className="primary-button"
          href={intentUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!intentUrl || undefined}
          onClick={(event) => {
            if (!intentUrl) {
              event.preventDefault();
              return;
            }
            track("x_web_intent");
          }}
        >
          Reply on X
        </a>
        <button type="button" className="secondary-button" disabled={!check.ok} onClick={copyAndOpen}>
          Copy &amp; open post
        </button>
      </div>

      <div aria-live="polite">
        {!check.ok && text.trim() !== "" && (
          <p className="form-message" data-status="error">
            {check.error}
          </p>
        )}
        {tracking === "saved" && (
          <p className="form-message">
            Opened on X. Post it there; Scout keeps it in your <a href="/activity">Activity</a> as unconfirmed.
          </p>
        )}
        {tracking === "failed" && (
          <p className="form-message" data-status="error">
            {message} X still opened.{" "}
            <button type="button" className="text-link" onClick={() => track("x_web_intent")}>
              Save to Activity again
            </button>
          </p>
        )}
        {tracking !== "failed" && message && (
          <p className="form-message" data-status="error">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
