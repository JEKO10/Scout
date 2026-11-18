"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import {
  deleteAutomationAction,
  enableGrowthPlanRemindersAction,
  markAutomationNotificationsReadAction,
  setReviewItemAction,
  toggleAutomationAction,
} from "@/actions/automations";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Message = { ok: boolean; text: string } | null;

function Notice({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
      {message.text}
    </p>
  );
}

export function AutomationRowControls({ id, name, enabled }: { id: string; name: string; enabled: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="task-controls">
      <label className="automation-chip">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(e) =>
            startTransition(async () => {
              const result = await toggleAutomationAction(id, e.target.checked);
              setMessage(result.ok ? null : { ok: false, text: result.message });
            })
          }
        />
        On
      </label>
      <Link className="text-button" href={`/automations?edit=${id}#builder`}>
        Edit
      </Link>
      <button type="button" className="text-button" disabled={pending} onClick={() => setConfirming(true)}>
        Delete
      </button>
      <Notice message={message} />
      <ConfirmDialog
        open={confirming}
        title={`Delete "${name}"?`}
        confirmLabel="Delete"
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            const result = await deleteAutomationAction(id);
            setMessage(result.ok ? null : { ok: false, text: result.message });
            setConfirming(false);
          })
        }
        onCancel={() => setConfirming(false)}
      >
        <p>Its history is deleted too. Items already in your review queue stay.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Review queue item: reviewed / done / dismiss */
export function ReviewItemControls({ id, kind }: { id: string; kind: "review" | "reminder" }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const run = (status: "reviewed" | "dismissed" | "done") =>
    startTransition(async () => {
      const result = await setReviewItemAction(id, status);
      setMessage(result.ok ? null : { ok: false, text: result.message });
    });
  return (
    <div className="task-controls">
      <button type="button" className="secondary-button" disabled={pending} onClick={() => run(kind === "reminder" ? "done" : "reviewed")}>
        {kind === "reminder" ? "Done" : "Reviewed"}
      </button>
      <button type="button" className="text-button" disabled={pending} onClick={() => run("dismissed")}>
        Dismiss
      </button>
      <Notice message={message} />
    </div>
  );
}

export function MarkReadButton({ id }: { id?: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button type="button" className="text-button" disabled={pending} onClick={() => startTransition(async () => void (await markAutomationNotificationsReadAction(id)))}>
      {id ? "Mark read" : "Mark all read"}
    </button>
  );
}

/** On /strategy: one click turns on reminders for the weekly plan */
export function GrowthPlanRemindersButton({ active }: { active: boolean }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  if (active) return <p className="memory-note">Reminders for your plan tasks are on. They appear in Automations on each task&apos;s day.</p>;
  return (
    <div className="task-controls">
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await enableGrowthPlanRemindersAction();
            setMessage({ ok: result.ok, text: result.message });
          })
        }
      >
        Remind me when a task is due
      </button>
      <Notice message={message} />
    </div>
  );
}
