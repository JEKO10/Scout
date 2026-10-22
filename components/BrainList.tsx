"use client";

import { useOptimistic, useState, useTransition } from "react";

import { type BrainEdit, editBrainAction } from "@/actions/brain";
import type { BrainItem } from "@/services/scout-brain/resolveBrain";

const evidenceLabels = {
  observed: "Seen in your posts",
  stated: "From your onboarding answers",
  inferred: "AI guess. Remove it if it's wrong",
} as const;

export function BrainList({
  brain,
  list,
  items,
  addLabel,
  emptyLabel = "Nothing here yet.",
}: {
  brain: BrainEdit["brain"];
  list: string;
  items: BrainItem[];
  addLabel: string;
  emptyLabel?: string;
}) {
  const [optimisticItems, applyOptimistic] = useOptimistic(
    items,
    (current, edit: Pick<BrainEdit, "op" | "value">) =>
      edit.op === "remove"
        ? current.filter((item) => item.label !== edit.value)
        : [...current, { label: edit.value, source: "user" as const }],
  );
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function edit(op: BrainEdit["op"], value: string) {
    setError(null);
    startTransition(async () => {
      applyOptimistic({ op, value });
      const result = await editBrainAction({ brain, list, op, value });
      if (result.status === "error") setError(result.message ?? "Couldn't save.");
    });
  }

  return (
    <div className="brain-list" aria-busy={pending}>
      <ul>
        {optimisticItems.map((item) => (
          <li
            key={item.label}
            className="brain-chip"
            data-source={item.source}
            data-evidence={item.evidence}
            title={[item.evidence && evidenceLabels[item.evidence], item.detail]
              .filter(Boolean)
              .join(" · ")}
          >
            <span>{item.label}</span>
            <button
              type="button"
              onClick={() => edit("remove", item.label)}
              aria-label={`Remove ${item.label}`}
            >
              ×
            </button>
          </li>
        ))}

        {optimisticItems.length === 0 && !adding && (
          <li className="brain-empty">{emptyLabel}</li>
        )}

        <li>
          {adding ? (
            <form
              className="brain-add-form"
              onSubmit={(event) => {
                event.preventDefault();
                const value = draft.trim();
                if (value) edit("add", value);
                setDraft("");
                setAdding(false);
              }}
            >
              <input
                autoFocus
                value={draft}
                maxLength={80}
                placeholder={addLabel}
                aria-label={addLabel}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => !draft.trim() && setAdding(false)}
                onKeyDown={(event) => event.key === "Escape" && setAdding(false)}
              />
            </form>
          ) : (
            <button
              type="button"
              className="brain-add"
              onClick={() => setAdding(true)}
            >
              + Add
            </button>
          )}
        </li>
      </ul>
      {error && (
        <p className="form-message" data-status="error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
