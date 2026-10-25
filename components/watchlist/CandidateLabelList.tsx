"use client";

import { useOptimistic, useTransition } from "react";

import { setCandidateLabelAction } from "@/actions/candidates";
import type { ScoutCandidate } from "@/db/schema";

type Label = NonNullable<ScoutCandidate["userLabel"]>;

// Deliberately no score here: the list is for blind labeling
type Candidate = Pick<
  ScoutCandidate,
  "id" | "authorHandle" | "url" | "kind" | "postedAt" | "content" | "userLabel"
>;

const labels: { value: Label; text: string }[] = [
  { value: "yes", text: "Yes" },
  { value: "maybe", text: "Maybe" },
  { value: "no", text: "No" },
];

const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function CandidateLabelList({ candidates }: { candidates: Candidate[] }) {
  const [items, setOptimistic] = useOptimistic(
    candidates,
    (current, change: { id: string; label: Label | null }) =>
      current.map((item) =>
        item.id === change.id ? { ...item, userLabel: change.label } : item,
      ),
  );
  const [, startTransition] = useTransition();
  const labeled = items.filter((item) => item.userLabel).length;

  function choose(candidate: Candidate, label: Label) {
    // Clicking the chosen label again clears it
    const next = candidate.userLabel === label ? null : label;
    startTransition(async () => {
      setOptimistic({ id: candidate.id, label: next });
      await setCandidateLabelAction(candidate.id, next);
    });
  }

  return (
    <>
      <p className="candidate-progress">
        {labeled} of {items.length} labeled. Would you reply to this post?
      </p>
      <ul className="candidate-list">
        {items.map((candidate) => (
          <li key={candidate.id} data-labeled={candidate.userLabel ?? undefined}>
            <div>
              <p className="candidate-meta">
                <a href={candidate.url} target="_blank" rel="noreferrer">
                  @{candidate.authorHandle}
                </a>{" "}
                · {candidate.kind} · {dateFormat.format(candidate.postedAt)}
              </p>
              <p className="candidate-text">{candidate.content}</p>
            </div>
            <div className="candidate-labels" role="group" aria-label="Your label">
              {labels.map(({ value, text }) => (
                <button
                  key={value}
                  type="button"
                  className="eval-choice"
                  data-label={value}
                  aria-pressed={candidate.userLabel === value}
                  onClick={() => choose(candidate, value)}
                >
                  {text}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
