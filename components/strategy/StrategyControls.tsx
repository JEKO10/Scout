"use client";

import { useState, useTransition } from "react";

import {
  addObservationAction,
  finishExperimentAction,
  generateStrategyAction,
  startExperimentAction,
  startPresetExperimentAction,
  updateTaskAction,
} from "@/actions/strategy";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  OBJECTIVE_LABEL,
  PEER_MODE_LABEL,
  PEER_MODES,
  type PeerMode,
  STRATEGY_OBJECTIVES,
  type StrategyObjective,
  WEEKLY_MINUTES_OPTIONS,
} from "@/lib/strategy/types";

type Message = { ok: boolean; text: string } | null;

function Notice({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
      {message.text}
    </p>
  );
}

const hoursLabel = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`);

/** Objective, weekly time, and the one button that asks the AI (cached server-side) */
export function StrategyForm({
  initial,
  hasStrategy,
  upToDate,
  allowance,
}: {
  initial: { objective: StrategyObjective; weeklyMinutes: number; peerMode: PeerMode };
  hasStrategy: boolean;
  upToDate: boolean;
  allowance: { used: number; cap: number };
}) {
  const [objective, setObjective] = useState(initial.objective);
  const [weeklyMinutes, setWeeklyMinutes] = useState(initial.weeklyMinutes);
  const [peerMode, setPeerMode] = useState(initial.peerMode);
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const changed = objective !== initial.objective || weeklyMinutes !== initial.weeklyMinutes || peerMode !== initial.peerMode;
  const left = Math.max(0, allowance.cap - allowance.used);

  return (
    <div className="strategy-form">
      <label>
        <span>Goal</span>
        <select value={objective} onChange={(event) => setObjective(event.target.value as StrategyObjective)} disabled={pending}>
          {STRATEGY_OBJECTIVES.map((value) => (
            <option key={value} value={value}>
              {OBJECTIVE_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Time per week</span>
        <select value={weeklyMinutes} onChange={(event) => setWeeklyMinutes(Number(event.target.value))} disabled={pending}>
          {WEEKLY_MINUTES_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {hoursLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Learn from</span>
        <select value={peerMode} onChange={(event) => setPeerMode(event.target.value as PeerMode)} disabled={pending}>
          {PEER_MODES.map((value) => (
            <option key={value} value={value}>
              {PEER_MODE_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={pending || left === 0 || (hasStrategy && upToDate && !changed)}
        onClick={() =>
          startTransition(async () => {
            const result = await generateStrategyAction({ objective, weeklyMinutes, peerMode });
            setMessage({ ok: result.ok, text: result.message });
          })
        }
      >
        {pending ? "Writing your plan…" : hasStrategy ? "Update plan" : "Create my plan"}
      </button>
      <small>
        {hasStrategy && upToDate && !changed
          ? "Up to date with your data. "
          : ""}
        {left} of {allowance.cap} plan {allowance.cap === 1 ? "update" : "updates"} left this month.
      </small>
      <Notice message={message} />
    </div>
  );
}

/** Done / skip / move to another day of the plan */
export function TaskControls({ taskId, status, day, days }: { taskId: string; status: "todo" | "done" | "skipped"; day: string; days: { value: string; label: string }[] }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const run = (change: Parameters<typeof updateTaskAction>[1]) =>
    startTransition(async () => {
      const result = await updateTaskAction(taskId, change);
      setMessage(result.ok ? null : { ok: false, text: result.message });
    });

  return (
    <div className="task-controls">
      {status === "todo" ? (
        <>
          <button type="button" className="secondary-button" disabled={pending} onClick={() => run({ status: "done" })}>
            Done
          </button>
          <button type="button" className="text-button" disabled={pending} onClick={() => run({ status: "skipped" })}>
            Skip
          </button>
          <select
            aria-label="Move to another day"
            value={day}
            disabled={pending}
            onChange={(event) => run({ day: event.target.value })}
          >
            {days.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      ) : (
        <button type="button" className="text-button" disabled={pending} onClick={() => run({ status: "todo" })}>
          Undo
        </button>
      )}
      <Notice message={message} />
    </div>
  );
}

/** Start a proposed experiment, or dismiss it */
export function ProposedExperimentControls({ experimentId }: { experimentId: string }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="task-controls">
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await startExperimentAction(experimentId);
            setMessage({ ok: result.ok, text: result.message });
          })
        }
      >
        Start experiment
      </button>
      <button
        type="button"
        className="text-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await finishExperimentAction(experimentId, { status: "stopped", conclusion: "" });
            setMessage(result.ok ? null : { ok: false, text: result.message });
          })
        }
      >
        Not now
      </button>
      <Notice message={message} />
    </div>
  );
}

export function PresetButton({ presetKey, title }: { presetKey: string; title: string }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await startPresetExperimentAction(presetKey);
            setMessage({ ok: result.ok, text: result.message });
          })
        }
      >
        Start: {title}
      </button>
      <Notice message={message} />
    </>
  );
}

/** Notes while it runs, and a conclusion when it ends */
export function ActiveExperimentControls({ experimentId }: { experimentId: string }) {
  const [note, setNote] = useState("");
  const [finishing, setFinishing] = useState<"completed" | "stopped" | null>(null);
  const [conclusion, setConclusion] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="experiment-controls">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await addObservationAction(experimentId, note);
            setMessage({ ok: result.ok, text: result.message });
            if (result.ok) setNote("");
          });
        }}
      >
        <input
          type="text"
          value={note}
          maxLength={500}
          placeholder="Add an observation, e.g. 'question posts got 3 thoughtful replies'"
          onChange={(event) => setNote(event.target.value)}
          aria-label="Observation"
        />
        <button type="submit" className="secondary-button" disabled={pending || note.trim().length < 2}>
          Save
        </button>
      </form>
      <div className="task-controls">
        <button type="button" className="secondary-button" disabled={pending} onClick={() => setFinishing("completed")}>
          Finish
        </button>
        <button type="button" className="text-button" disabled={pending} onClick={() => setFinishing("stopped")}>
          Stop
        </button>
      </div>
      <Notice message={message} />
      <ConfirmDialog
        open={finishing !== null}
        title={finishing === "completed" ? "Finish this experiment?" : "Stop this experiment?"}
        confirmLabel={finishing === "completed" ? "Finish" : "Stop"}
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            const result = await finishExperimentAction(experimentId, { status: finishing ?? "completed", conclusion });
            setMessage({ ok: result.ok, text: result.message });
            setFinishing(null);
          })
        }
        onCancel={() => setFinishing(null)}
      >
        <label className="experiment-conclusion">
          <span>Your conclusion (optional)</span>
          <textarea
            value={conclusion}
            maxLength={800}
            rows={3}
            placeholder="What did you learn? What will you keep doing?"
            onChange={(event) => setConclusion(event.target.value)}
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}
