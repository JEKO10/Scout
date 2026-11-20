"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";

import { inboxActAction, inboxDecideRevisionAction, inboxDeclineReasonAction, inboxReviseAction } from "@/actions/inbox";
import { recordReplyIntentAction } from "@/actions/replyIntents";
import { type CardAction, type CardSpec,cardSpec } from "@/lib/inbox/cards";
import { DECLINE_LABEL, DECLINE_REASONS, type InboxItem } from "@/lib/inbox/types";

import { InboxEditor } from "./InboxEditor";
import { PublishCard } from "./PublishCard";

type Preview = { revisionId: string; text: string; warning: string | null };
type Outcome = { text: string; copyText?: string; openUrl?: string | null; opportunityId?: string; replyId?: string };
type Mode = "view" | "edit" | "approved" | "done" | "feedback" | "gone";

/** 24×24 line icons in the nav's style */
const ICONS: Record<CardSpec["icon"] | "edit" | "regenerate" | "decline" | "check", ReactNode> = {
  reply: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  post: <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" />,
  conversation: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  lead: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  idea: <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9" />,
  reminder: <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" />,
  edit: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />,
  regenerate: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  decline: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12 5 5 9-10" />,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const SECONDARY_ICON: Partial<Record<CardAction, keyof typeof ICONS>> = { edit: "edit", regenerate: "regenerate", decline: "decline", dismiss: "decline" };

/**
 * One Home card, in three parts: what it is (icon, label, age), the
 * prepared work with one line of why, and one primary action with a few
 * quiet ones. Everything happens here; only "View on X" leaves Scout.
 */
export function InboxCard({ item }: { item: InboxItem }) {
  // Day 40: an approved post on its way to X has its own actions
  if (item.type === "publish" && item.publication) return <PublishCard item={item} publication={item.publication} />;
  return <WorkCard item={item} />;
}

function WorkCard({ item }: { item: InboxItem }) {
  const router = useRouter();
  const spec = cardSpec(item);
  const [text, setText] = useState(item.text);
  const [mode, setMode] = useState<Mode>("view");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<CardAction | null>(null);

  function close() {
    setMode("gone");
    router.refresh();
  }

  // A short success line, then the card leaves (approvals and started experiments stay until closed)
  useEffect(() => {
    if (mode !== "done" || item.type === "recommendation") return;
    const timer = setTimeout(close, 2200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function run(action: CardAction) {
    setError(null);
    if (action === "edit") return setMode("edit");
    if (action === "regenerate") return regenerate();
    setBusy(action);
    startTransition(async () => {
      const result = await inboxActAction(item.key, action);
      setBusy(null);
      if (!result.ok) return setError(result.message);
      // The page re-renders: the new draft(s) arrive as cards to approve
      if (action === "write_reply" || action === "prepare") return;
      // Approved for publishing: the page re-renders it as "Ready to publish"
      if (action === "approve" && result.publicationId) return router.refresh();
      const next: Outcome = { text: result.outcome, copyText: result.copyText, openUrl: result.openUrl, opportunityId: result.opportunityId, replyId: result.replyId };
      setOutcome(next);
      if (action === "approve" && !result.already) return setMode("approved");
      // Declined / dismissed: gone at once; why is optional
      if ((action === "decline" || action === "dismiss") && item.type !== "lead" && item.type !== "recommendation") return setMode("feedback");
      setMode("done");
    });
  }

  function regenerate() {
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

  const head = (
    <div className="inbox-card-head">
      <span className="inbox-icon" data-icon={spec.icon}>
        <Icon name={spec.icon} />
      </span>
      <div>
        <p className="inbox-label">{item.label}</p>
        {item.meta && <p className="inbox-meta">{item.meta}</p>}
      </div>
    </div>
  );

  if (mode === "feedback") {
    return (
      <article className="inbox-card inbox-card-compact" aria-live="polite">
        <p className="inbox-done-line">Removed. Why wasn&apos;t this useful? <span className="inbox-optional">(optional)</span></p>
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
          <button type="button" className="inbox-chip inbox-chip-quiet" onClick={close}>
            Skip
          </button>
        </div>
      </article>
    );
  }

  if (mode === "done" && outcome) {
    return (
      <article className="inbox-card inbox-card-compact" data-type={item.type} aria-live="polite">
        <p className="inbox-success">
          <Icon name="check" /> {outcome.text}
        </p>
        {item.type === "recommendation" && (
          <button type="button" className="inbox-ghost" onClick={close}>
            Close
          </button>
        )}
      </article>
    );
  }

  if (mode === "approved" && outcome) {
    return (
      <article className="inbox-card" data-type={item.type} aria-live="polite">
        {head}
        <div className="inbox-card-body">
          <p className="inbox-success">
            <Icon name="check" /> {outcome.text}
          </p>
          <p className="inbox-work">{outcome.copyText ?? text}</p>
        </div>
        <div className="inbox-card-actions">
          {outcome.copyText && (
            <button type="button" className="primary-button inbox-primary" onClick={() => copy(outcome.copyText!)}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          <div className="inbox-secondary">
            {outcome.openUrl && (
              <a className="inbox-ghost" href={outcome.openUrl} target="_blank" rel="noreferrer" onClick={() => recordIntent("x_web_intent")}>
                {item.type === "reply" ? "Reply on X" : "Post on X"} ↗
              </a>
            )}
            <button type="button" className="inbox-ghost" onClick={close}>
              Close
            </button>
          </div>
        </div>
        {error && <p className="form-message inbox-error" data-status="error" role="alert">{error}</p>}
      </article>
    );
  }

  const conversation = item.context && (item.type === "reply" || item.type === "conversation" || item.type === "lead");

  return (
    <article className="inbox-card" data-type={item.type} data-mode={mode} aria-busy={pending}>
      {head}

      <div className="inbox-card-body">
        {conversation && (
          <div className="inbox-source">
            <p className="inbox-source-author">
              {item.context!.author ? `@${item.context!.author}` : "On X"}
              {item.externalUrl && (
                <a className="inbox-source-link" href={item.externalUrl} target="_blank" rel="noreferrer">
                  View on X ↗
                </a>
              )}
            </p>
            {/* The post being answered: always readable before approving */}
            {item.type === "reply" ? (
              <>
                <p className="inbox-source-text" data-open={contextOpen || undefined}>
                  {item.context!.text}
                </p>
                {item.context!.text.length > 140 && (
                  <button type="button" className="inbox-more" onClick={() => setContextOpen((open) => !open)} aria-expanded={contextOpen}>
                    {contextOpen ? "Show less" : "Show full post"}
                  </button>
                )}
              </>
            ) : (
              <p className="inbox-source-text" data-open>
                {item.context!.text}
              </p>
            )}
          </div>
        )}

        {item.headline && <p className="inbox-headline">{item.headline}</p>}

        {mode === "edit" ? (
          <InboxEditor itemKey={item.key} initialText={text} onChange={setText} onApprove={() => run("approve")} onClose={() => setMode("view")} approving={busy === "approve"} />
        ) : preview ? (
          <div className="inbox-preview" aria-live="polite">
            <p className="inbox-preview-label">Here&apos;s another version.</p>
            <p className="inbox-work">{preview.text}</p>
            {preview.warning && <p className="inbox-warning">{preview.warning}</p>}
            <div className="inbox-preview-actions">
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
          item.type !== "conversation" &&
          item.type !== "lead" && <p className={item.type === "post" || item.type === "reply" ? "inbox-work" : "inbox-text"}>{text}</p>
        )}

        {item.steps && item.steps.length > 0 && mode === "view" && (
          <ul className="inbox-steps">
            {item.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        )}
        {mode === "view" && !preview && <p className="inbox-why">{item.why}</p>}
        {busy === "regenerate" && !preview && <p className="inbox-why" aria-live="polite">Writing another version…</p>}
      </div>

      {mode === "view" && !preview && (
        <div className="inbox-card-actions">
          <button type="button" className="primary-button inbox-primary" onClick={() => run(spec.primary.action)} disabled={pending}>
            {spec.primary.action === "approve" && <Icon name="check" />}
            {busy === spec.primary.action ? "Working…" : spec.primary.label}
          </button>
          <div className="inbox-secondary">
            {spec.secondary.map(({ action, label }) => (
              <button key={action} type="button" className="inbox-ghost" onClick={() => run(action)} disabled={pending}>
                {SECONDARY_ICON[action] && <Icon name={SECONDARY_ICON[action]!} />}
                {busy === action ? "…" : label}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="form-message inbox-error" data-status="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
