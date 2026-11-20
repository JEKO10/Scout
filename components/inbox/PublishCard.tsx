"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { inboxActAction } from "@/actions/inbox";
import { deletePublishedAction, publishNowAction, schedulePublicationAction, unschedulePublicationAction } from "@/actions/publishing";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { InboxItem, PublicationCard } from "@/lib/inbox/types";

import { InboxEditor } from "./InboxEditor";

type Mode = "view" | "edit" | "schedule" | "published" | "gone";

const SEND = <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />;
const CHECK = <path d="m5 12 5 5 9-10" />;

/**
 * Day 40: an approved post on its way to X. Publish now, or Schedule, the
 * exact text the user approved; Edit means approving the new text again.
 * Without publishing permission: "Enable X publishing" (back here after X).
 * Also used on the draft's page in Studio (`returnTo`).
 */
export function PublishCard({ item, publication, returnTo = "/dashboard" }: { item: Pick<InboxItem, "label" | "text" | "why" | "meta">; publication: PublicationCard; returnTo?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(publication.status === "published" ? "published" : "view");
  const [error, setError] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(publication.postUrl);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [date, setDate] = useState(publication.defaultDate);
  const [time, setTime] = useState(publication.defaultTime);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  const run = (what: string, task: () => Promise<{ ok: boolean; message?: string } | void>) => {
    setError(null);
    setBusy(what);
    startTransition(async () => {
      const result = await task();
      setBusy(null);
      if (result && !result.ok) setError(result.message ?? "Something went wrong.");
    });
  };

  const publishNow = () =>
    run("publish", async () => {
      const result = await publishNowAction(publication.id);
      if (result.ok && result.status === "published") {
        setPostUrl(result.postUrl ?? null);
        setMode("published");
        return;
      }
      if (!result.ok) {
        router.refresh();
        return result;
      }
    });

  async function copy() {
    try {
      await navigator.clipboard.writeText(item.text);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the text and copy it yourself.");
    }
  }

  if (mode === "gone") return null;

  const head = (
    <div className="inbox-card-head">
      <span className="inbox-icon" data-icon="post">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {SEND}
        </svg>
      </span>
      <div>
        <p className="inbox-label">{mode === "published" ? "Published on X" : item.label}</p>
        {item.meta && mode !== "published" && <p className="inbox-meta">{item.meta}</p>}
      </div>
    </div>
  );

  if (mode === "published") {
    return (
      <article className="inbox-card" data-type="publish" aria-live="polite">
        {head}
        <div className="inbox-card-body">
          <p className="inbox-success">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {CHECK}
            </svg>
            X confirmed it: your post is live.
          </p>
          <p className="inbox-work">{item.text}</p>
        </div>
        <div className="inbox-card-actions">
          {postUrl && (
            <a className="primary-button inbox-primary" href={postUrl} target="_blank" rel="noreferrer">
              View on X ↗
            </a>
          )}
          <div className="inbox-secondary">
            <button type="button" className="inbox-ghost" onClick={() => setConfirmDelete(true)} disabled={pending}>
              Delete from X
            </button>
            <button
              type="button"
              className="inbox-ghost"
              onClick={() => {
                setMode("gone");
                router.refresh();
              }}
            >
              Close
            </button>
          </div>
        </div>
        {error && <p className="form-message inbox-error" data-status="error" role="alert">{error}</p>}
        <ConfirmDialog
          open={confirmDelete}
          title="Delete this post from X?"
          confirmLabel="Delete from X"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            run("delete", async () => {
              const result = await deletePublishedAction(publication.id);
              if (result.ok) {
                setMode("gone");
                router.refresh();
              }
              return result;
            });
          }}
        >
          <p>It&apos;s removed from your X profile. The draft stays in Content.</p>
        </ConfirmDialog>
      </article>
    );
  }

  const inFlight = publication.status === "publishing" || publication.status === "unknown";
  const canAct = !inFlight && publication.planAllows;
  const enableHref = `/api/x/oauth/start?publish=1&return=${encodeURIComponent(returnTo)}`;

  return (
    <article className="inbox-card" data-type="publish" data-mode={mode === "edit" ? "edit" : undefined} aria-busy={pending}>
      {head}
      <div className="inbox-card-body">
        {mode === "edit" && publication.draftId ? (
          <>
            <p className="inbox-why">Changing the text means approving it again before it can be published.</p>
            <InboxEditor
              itemKey={`draft:${publication.draftId}`}
              initialText={item.text}
              onChange={() => undefined}
              approving={busy === "approve"}
              onApprove={() =>
                run("approve", async () => {
                  const result = await inboxActAction(`draft:${publication.draftId}`, "approve");
                  router.refresh();
                  setMode("view");
                  if (!result.ok) return result;
                })
              }
              onClose={() => {
                setMode("view");
                router.refresh();
              }}
            />
          </>
        ) : (
          <>
            <p className="inbox-work">{item.text}</p>
            <p className="inbox-why">{item.why}</p>
          </>
        )}
        {mode === "schedule" && (
          <form
            className="inbox-schedule"
            onSubmit={(event) => {
              event.preventDefault();
              run("schedule", async () => {
                const result = await schedulePublicationAction(publication.id, { date, time, timeZone: publication.timeZone });
                if (result.ok) setMode("view");
                return result;
              });
            }}
          >
            <label>
              <span className="sr-only">Date</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
            </label>
            <label>
              <span className="sr-only">Time</span>
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
            </label>
            <span className="inbox-tz">{publication.timeZone}</span>
            <button type="submit" className="primary-button" disabled={pending}>
              {busy === "schedule" ? "Scheduling…" : "Schedule"}
            </button>
            <button type="button" className="inbox-ghost" onClick={() => setMode("view")}>
              Cancel
            </button>
          </form>
        )}
      </div>

      {mode === "view" && (
        <div className="inbox-card-actions">
          {inFlight ? (
            <p className="inbox-why">Nothing to do: Scout updates this card when X answers.</p>
          ) : !publication.planAllows ? (
            <button type="button" className="primary-button inbox-primary" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          ) : !publication.canPublish ? (
            <a className="primary-button inbox-primary" href={enableHref}>
              Enable X publishing
            </a>
          ) : (
            <button type="button" className="primary-button inbox-primary" onClick={publishNow} disabled={pending}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {SEND}
              </svg>
              {busy === "publish" ? "Publishing…" : publication.status === "failed" ? "Try again" : "Publish now"}
            </button>
          )}
          {canAct && (
            <div className="inbox-secondary">
              {publication.canPublish &&
                (publication.status === "scheduled" ? (
                  <>
                    <button type="button" className="inbox-ghost" onClick={() => setMode("schedule")} disabled={pending}>
                      Reschedule
                    </button>
                    <button type="button" className="inbox-ghost" onClick={() => run("unschedule", () => unschedulePublicationAction(publication.id))} disabled={pending}>
                      Cancel schedule
                    </button>
                  </>
                ) : (
                  <button type="button" className="inbox-ghost" onClick={() => setMode("schedule")} disabled={pending}>
                    Schedule
                  </button>
                ))}
              {publication.draftId && publication.status !== "scheduled" && (
                <button type="button" className="inbox-ghost" onClick={() => setMode("edit")} disabled={pending}>
                  Edit
                </button>
              )}
              <button type="button" className="inbox-ghost" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
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
