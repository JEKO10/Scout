"use client";

import { useState, useTransition } from "react";

import { rateEvalResultAction } from "@/actions/eval";
import type { EvalRunWithResults } from "@/db/queries/eval";

import { categoryLabels } from "./categories";

type Result = EvalRunWithResults["results"][number];

type Draft = {
  voiceScore: number | null;
  wouldPost: boolean | null;
  tooGeneric: boolean | null;
  decisionCorrect: boolean | null;
  notes: string;
};

const toDraft = (result: Result): Draft => ({
  voiceScore: result.voiceScore,
  wouldPost: result.wouldPost,
  tooGeneric: result.tooGeneric,
  decisionCorrect: result.decisionCorrect,
  notes: result.notes ?? "",
});

export function EvalRunner({ results }: { results: Result[] }) {
  const firstUnrated = results.findIndex((result) => result.voiceScore === null);
  const [index, setIndex] = useState(firstUnrated === -1 ? 0 : firstUnrated);
  const [drafts, setDrafts] = useState(() => results.map(toDraft));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const result = results[index];
  const draft = drafts[index];
  const complete =
    draft.voiceScore !== null &&
    draft.wouldPost !== null &&
    draft.tooGeneric !== null &&
    draft.decisionCorrect !== null;

  function update(patch: Partial<Draft>) {
    setDrafts((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  function saveAndGo(nextIndex: number) {
    if (!complete) {
      setError("Answer every question before moving on.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const saved = await rateEvalResultAction({
        resultId: result.id,
        voiceScore: draft.voiceScore!,
        wouldPost: draft.wouldPost!,
        tooGeneric: draft.tooGeneric!,
        decisionCorrect: draft.decisionCorrect!,
        notes: draft.notes,
      });
      if (saved.status === "error") setError(saved.message ?? "Couldn't save.");
      else setIndex(Math.min(nextIndex, results.length - 1));
    });
  }

  const { decision } = result;

  return (
    <section className="eval-section" aria-labelledby="eval-case-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            Post {index + 1} of {results.length} · You expected:{" "}
            {categoryLabels[result.evalCase.category]}
          </p>
          <h2 id="eval-case-title">Rate Scout&apos;s answer</h2>
        </div>
        <ol className="eval-dots" aria-label="Progress">
          {results.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                aria-label={`Go to post ${i + 1}`}
                aria-current={i === index || undefined}
                data-rated={drafts[i].voiceScore !== null || undefined}
                onClick={() => setIndex(i)}
              />
            </li>
          ))}
        </ol>
      </div>

      <div className="eval-case">
        {/* Left: what Scout produced */}
        <div className="eval-content">
          <article className="eval-card">
            <p className="eyebrow">The post · @{result.evalCase.authorHandle}</p>
            <p className="eval-post">{result.evalCase.content}</p>
          </article>

          <article className="eval-card eval-card-reply">
            <p className="eyebrow">Scout&apos;s reply · {result.reply.length} characters</p>
            <p className="eval-reply">{result.reply}</p>
          </article>

          <article className="eval-card">
            <p className="eyebrow">Scout&apos;s call: should you reply at all?</p>
            <p className="eval-decision" data-engage={decision.shouldEngage || undefined}>
              <strong>{decision.shouldEngage ? "Yes, engage" : "No, skip it"}</strong>
              <span>{decision.relevance} relevance</span>
            </p>
            <p className="eval-why">{decision.why}</p>
            <dl className="brain-facts">
              <div>
                <dt>Expertise</dt>
                <dd>{decision.relevantExpertise ?? "—"}</dd>
              </div>
              <div>
                <dt>Past opinion</dt>
                <dd>{decision.relevantOpinion ?? "—"}</dd>
              </div>
              <div>
                <dt>What you&apos;d add</dt>
                <dd>{decision.valueAdd ?? "—"}</dd>
              </div>
            </dl>
          </article>
        </div>

        {/* Right: the user's rating, always in view */}
        <aside className="eval-rating" aria-label="Your rating">
          <p className="eyebrow">Your rating</p>

          <fieldset>
            <legend>
              <span className="eval-step">1</span> Does the reply sound like me?
            </legend>
            <div className="eval-choices eval-scale">
              {[1, 2, 3, 4, 5].map((score) => (
                <Choice
                  key={score}
                  selected={draft.voiceScore === score}
                  onClick={() => update({ voiceScore: score })}
                >
                  {score}
                </Choice>
              ))}
            </div>
            <p className="eval-scale-hint">
              <span>Not at all</span>
              <span>Exactly me</span>
            </p>
          </fieldset>
          <YesNo
            step={2}
            legend="Would I actually post this reply?"
            value={draft.wouldPost}
            onChange={(wouldPost) => update({ wouldPost })}
          />
          <YesNo
            step={3}
            legend="Is the reply too generic?"
            value={draft.tooGeneric}
            onChange={(tooGeneric) => update({ tooGeneric })}
          />
          <YesNo
            step={4}
            legend="Was Scout right about whether to reply?"
            value={draft.decisionCorrect}
            onChange={(decisionCorrect) => update({ decisionCorrect })}
          />
          <label className="eval-notes">
            <span>Notes (optional)</span>
            <textarea
              className="field-control"
              rows={3}
              value={draft.notes}
              placeholder="Why? Too corporate, too long, always agrees, invented expertise…"
              onChange={(event) => update({ notes: event.target.value })}
            />
          </label>

          <div className="eval-footer">
            <div aria-live="polite">
              {error && (
                <p className="form-message" data-status="error">
                  {error}
                </p>
              )}
            </div>
            <div className="eval-nav">
              <button
                type="button"
                className="secondary-button"
                disabled={index === 0 || pending}
                onClick={() => setIndex(index - 1)}
              >
                Back
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={pending}
                onClick={() => saveAndGo(index + 1)}
              >
                {pending
                  ? "Saving…"
                  : index === results.length - 1
                    ? "Save"
                    : "Save & next"}
              </button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="eval-choice"
      aria-pressed={selected}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function YesNo({
  step,
  legend,
  value,
  onChange,
}: {
  step: number;
  legend: string;
  value: boolean | null;
  onChange: (value: boolean) => void;
}) {
  return (
    <fieldset>
      <legend>
        <span className="eval-step">{step}</span> {legend}
      </legend>
      <div className="eval-choices">
        <Choice selected={value === true} onClick={() => onChange(true)}>
          Yes
        </Choice>
        <Choice selected={value === false} onClick={() => onChange(false)}>
          No
        </Choice>
      </div>
    </fieldset>
  );
}
