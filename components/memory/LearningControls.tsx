"use client";

import { useTransition } from "react";

import { rejectLearnedItemAction, updateLearningAction } from "@/actions/learning";

export function UpdateLearningButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="secondary-button"
      disabled={pending}
      onClick={() => startTransition(() => updateLearningAction())}
    >
      {pending ? "Learning…" : "Update learning now"}
    </button>
  );
}

export function ThatsWrongButton({ itemKey, label }: { itemKey: string; label: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="learned-wrong"
      disabled={pending}
      aria-label={`That's wrong: ${label}`}
      onClick={() => startTransition(() => rejectLearnedItemAction(itemKey))}
    >
      {pending ? "Removing…" : "That's wrong"}
    </button>
  );
}
