"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  addLeadNoteAction,
  completeFollowUpAction,
  deleteLeadAction,
  deleteLeadNoteAction,
  editLeadNoteAction,
  leadOpenedAction,
  logLeadInteractionAction,
  setFollowUpAction,
  setLeadSavedAction,
  startLeadReplyAction,
} from "@/actions/leads";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Result = { ok: boolean; message?: string };

export type NoteView = { id: string; body: string; createdLabel: string; edited: boolean };

/**
 * Lead detail actions: reply, open X, log what happened, follow-up, notes,
 * remove or delete. Everything the user records is labeled as theirs.
 */
export function LeadWorkspace({
  leadId,
  postUrl,
  saved,
  followUpDate,
  followUpNote,
  followUpPending,
  notes,
}: {
  leadId: string;
  postUrl: string;
  saved: boolean;
  followUpDate: string | null;
  followUpNote: string | null;
  followUpPending: boolean;
  notes: NoteView[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState(followUpDate ?? "");
  const [dateNote, setDateNote] = useState(followUpNote ?? "");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [confirm, setConfirm] = useState<null | "delete-lead" | { noteId: string }>(null);

  function run(action: () => Promise<Result>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      setMessage(result.ok ? (result.message ? { ok: true, text: result.message } : null) : { ok: false, text: result.message ?? "Something went wrong." });
      if (result.ok) after?.();
    });
  }

  return (
    <div className="crm-workspace" aria-busy={pending}>
      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}

      <section className="crm-panel" aria-labelledby="engage-title">
        <h2 id="engage-title">Engage</h2>
        <div className="calibration-actions">
          <button
            type="button"
            className="primary-button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await startLeadReplyAction(leadId);
                if (result.ok) router.push(result.href);
                else setMessage({ ok: false, text: result.message });
              })
            }
          >
            Generate reply
          </button>
          <a href={postUrl} target="_blank" rel="noreferrer" className="secondary-button" onClick={() => void leadOpenedAction(leadId)}>
            Open on X
          </a>
        </div>
        <p className="memory-note">Scout never messages anyone. Tell it what happened, so your pipeline stays accurate:</p>
        <div className="topic-actions">
          <button type="button" disabled={pending} onClick={() => run(() => logLeadInteractionAction(leadId, "contact"))}>
            I contacted them
          </button>
          <button type="button" disabled={pending} onClick={() => run(() => logLeadInteractionAction(leadId, "response"))}>
            They responded
          </button>
        </div>
      </section>

      <section className="crm-panel" aria-labelledby="followup-title">
        <h2 id="followup-title">Follow-up</h2>
        <div className="crm-followup">
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={pending} />
          </label>
          <label>
            Note (optional)
            <input value={dateNote} onChange={(e) => setDateNote(e.target.value)} maxLength={300} disabled={pending} placeholder="Ask how the launch went" />
          </label>
        </div>
        <div className="topic-actions">
          <button type="button" disabled={pending || !date} onClick={() => run(() => setFollowUpAction(leadId, date, dateNote))}>
            Save follow-up
          </button>
          {followUpPending && (
            <button type="button" disabled={pending} onClick={() => run(() => completeFollowUpAction(leadId))}>
              Mark done
            </button>
          )}
          {followUpDate && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => setFollowUpAction(leadId, null),
                  () => {
                    setDate("");
                    setDateNote("");
                  },
                )
              }
            >
              Clear
            </button>
          )}
        </div>
      </section>

      <section className="crm-panel" aria-labelledby="notes-title">
        <h2 id="notes-title">Notes</h2>
        <p className="memory-note">Private to you.</p>
        <textarea
          className="crm-note-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="What you learned about them, what to mention next time…"
          disabled={pending}
        />
        <div className="topic-actions">
          <button type="button" disabled={pending || !draft.trim()} onClick={() => run(() => addLeadNoteAction(leadId, draft), () => setDraft(""))}>
            Add note
          </button>
        </div>
        <ul className="crm-notes">
          {notes.map((note) =>
            editing?.id === note.id ? (
              <li key={note.id}>
                <textarea
                  className="crm-note-input"
                  value={editing.body}
                  onChange={(e) => setEditing({ id: note.id, body: e.target.value })}
                  rows={3}
                  maxLength={4000}
                />
                <div className="topic-actions">
                  <button type="button" disabled={pending} onClick={() => run(() => editLeadNoteAction(note.id, editing.body), () => setEditing(null))}>
                    Save
                  </button>
                  <button type="button" disabled={pending} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </li>
            ) : (
              <li key={note.id}>
                <p>{note.body}</p>
                <small>
                  {note.createdLabel}
                  {note.edited && " · edited"}
                </small>
                <div className="topic-actions">
                  <button type="button" disabled={pending} onClick={() => setEditing({ id: note.id, body: note.body })}>
                    Edit
                  </button>
                  <button type="button" data-danger disabled={pending} onClick={() => setConfirm({ noteId: note.id })}>
                    Delete
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      </section>

      <div className="topic-actions crm-danger">
        <button type="button" disabled={pending} onClick={() => run(() => setLeadSavedAction(leadId, !saved))}>
          {saved ? "Remove from CRM (keeps notes)" : "Save to CRM"}
        </button>
        <button type="button" data-danger disabled={pending} onClick={() => setConfirm("delete-lead")}>
          Delete lead
        </button>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "delete-lead" ? "Delete this lead?" : "Delete this note?"}
        confirmLabel={confirm === "delete-lead" ? "Delete lead" : "Delete note"}
        pending={pending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target === "delete-lead") {
            startTransition(async () => {
              const result = await deleteLeadAction(leadId);
              if (result.ok) router.push("/crm");
              else setMessage({ ok: false, text: result.message ?? "Couldn't delete." });
            });
          } else if (target) {
            run(() => deleteLeadNoteAction(target.noteId));
          }
        }}
      >
        <p className="memory-note">
          {confirm === "delete-lead"
            ? "Its notes, follow-up and history are deleted too. This can't be undone. To keep them, remove it from the CRM instead."
            : "This can't be undone."}
        </p>
      </ConfirmDialog>
    </div>
  );
}
