"use client";

import { useActionState, useTransition } from "react";

import {
  addEvalCaseAction,
  addSampleCasesAction,
  deleteEvalCaseAction,
  type EvalActionState,
} from "@/actions/eval";
import type { EvalCase } from "@/db/schema";

import { categoryLabels } from "./categories";

export function EvalCaseManager({ cases }: { cases: EvalCase[] }) {
  const [addState, addAction, adding] = useActionState<EvalActionState, FormData>(
    addEvalCaseAction,
    { status: "idle" },
  );
  const [pending, startTransition] = useTransition();

  return (
    <section className="eval-section" aria-labelledby="eval-cases-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Test set</p>
          <h2 id="eval-cases-title">{cases.length} posts by other people</h2>
          <p>
            Aim for 3 very relevant, 3 somewhat relevant, 2 you know but have little to
            add to, and 2 irrelevant. Your expectation is never shown to the model.
          </p>
        </div>
        {cases.length === 0 && (
          <button
            type="button"
            className="primary-button"
            disabled={pending}
            onClick={() => startTransition(() => addSampleCasesAction().then(() => undefined))}
          >
            {pending ? "Adding…" : "Add sample test set"}
          </button>
        )}
      </div>

      {cases.length > 0 && (
        <ul className="eval-case-list" aria-busy={pending}>
          {cases.map((evalCase) => (
            <li key={evalCase.id}>
              <span className="eval-category" data-category={evalCase.category}>
                {categoryLabels[evalCase.category]}
              </span>
              <p>
                <strong>@{evalCase.authorHandle}</strong> {evalCase.content}
              </p>
              <button
                type="button"
                className="eval-delete"
                aria-label={`Delete post by @${evalCase.authorHandle}`}
                disabled={pending}
                onClick={() => startTransition(() => deleteEvalCaseAction(evalCase.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <form action={addAction} className="eval-add-form">
        <input
          name="authorHandle"
          placeholder="@author"
          aria-label="Author handle"
          className="field-control"
          required
        />
        <select name="category" aria-label="Expected relevance" className="field-control" required>
          {Object.entries(categoryLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <textarea
          name="content"
          rows={2}
          placeholder="Paste the post text"
          aria-label="Post text"
          className="field-control"
          required
        />
        <button type="submit" className="secondary-button" disabled={adding}>
          {adding ? "Adding…" : "Add test post"}
        </button>
        {addState.message && (
          <p className="form-message" data-status={addState.status} role="status">
            {addState.message}
          </p>
        )}
      </form>
    </section>
  );
}
