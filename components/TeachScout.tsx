"use client";

import { useActionState, useState, useTransition } from "react";

import {
  addOpinionAction,
  type BrainActionState,
  rebuildBrainAction,
  removeOpinionAction,
} from "@/actions/brain";

export type TeachScoutData = {
  /** Questions that invite a take, from the user's own topics */
  prompts: string[];
  opinions: { id: string; prompt: string; text: string }[];
  calibrationCount: number;
  postedCount: number;
};

/**
 * Dashboard, for a Brain built without posts: write takes down in your own
 * words, then rebuild the Brain from them plus the replies you've posted.
 */
export function TeachScout({ data }: { data: TeachScoutData }) {
  const [promptIndex, setPromptIndex] = useState(0);
  const prompt = data.prompts[promptIndex % data.prompts.length] ?? "";
  const [saved, saveAction, saving] = useActionState<BrainActionState, FormData>(
    addOpinionAction,
    { status: "idle" },
  );
  const [rebuild, setRebuild] = useState<BrainActionState>({ status: "idle" });
  const [rebuilding, startRebuild] = useTransition();
  const [removing, startRemoving] = useTransition();

  return (
    <div className="teach-scout">
      <div className="teach-scout-heading">
        <div>
          <p className="eyebrow">Teach Scout more</p>
          <h3>Your takes, in your words</h3>
          <p>
            Scout knows you from a few replies. Every take you write here becomes its own
            opinion in your Brain, so matches and replies don&apos;t lean on just one.
          </p>
        </div>
      </div>

      <form action={saveAction} className="teach-scout-form">
        <input type="hidden" name="prompt" value={prompt} />
        <label htmlFor="teach-opinion">
          {prompt}
          {data.prompts.length > 1 && (
            <button
              type="button"
              className="text-link"
              onClick={() => setPromptIndex((index) => index + 1)}
            >
              Another question
            </button>
          )}
        </label>
        {/* React resets the form after the action, which clears the field */}
        <textarea
          id="teach-opinion"
          name="opinion"
          className="field-control"
          rows={3}
          maxLength={500}
          placeholder="Write it the way you'd post it."
          required
        />
        <div className="teach-scout-actions">
          <button type="submit" className="secondary-button" disabled={saving}>
            {saving ? "Saving…" : "Save take"}
          </button>
          {saved.message && (
            <p className="form-message" data-status={saved.status} role="status">
              {saved.message}
            </p>
          )}
        </div>
      </form>

      {data.opinions.length > 0 && (
        <ul className="memory-list teach-scout-opinions">
          {data.opinions.map((opinion) => (
            <li key={opinion.id}>
              <strong>{opinion.text}</strong>
              <button
                type="button"
                className="learned-wrong"
                disabled={removing}
                aria-label={`Remove take: ${opinion.text}`}
                onClick={() => startRemoving(() => removeOpinionAction(opinion.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="teach-scout-rebuild">
        <p>
          A rebuild reads {data.calibrationCount} calibration replies, {data.opinions.length}{" "}
          {data.opinions.length === 1 ? "take" : "takes"} and {data.postedCount} replies you
          posted. Your manual Brain edits stay.
        </p>
        <button
          type="button"
          className="primary-button"
          disabled={rebuilding}
          onClick={() =>
            startRebuild(async () => {
              setRebuild(await rebuildBrainAction());
            })
          }
        >
          {rebuilding ? (
            <>
              <span className="x-sync-spinner" aria-hidden="true" />
              Rebuilding…
            </>
          ) : (
            "Rebuild my Brain"
          )}
        </button>
        {rebuild.message && (
          <p className="form-message" data-status={rebuild.status} role="status">
            {rebuild.message}
          </p>
        )}
      </div>
    </div>
  );
}
