"use client";

import { useState, useTransition } from "react";

import { generateTrendInsightAction, setTrendSavedAction } from "@/actions/trends";

/** Save a trend, and ask for (or refresh) its AI insight */
export function TrendActions({
  trendId,
  saved,
  hasInsight,
  stale,
}: {
  trendId: string;
  saved: boolean;
  hasInsight: boolean;
  /** The evidence changed enough since the insight was written */
  stale: boolean;
}) {
  const [isSaved, setSaved] = useState(saved);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="calibration-actions">
      {(!hasInsight || stale) && (
        <button
          type="button"
          className="primary-button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setMessage(null);
              const result = await generateTrendInsightAction(trendId);
              if (!result.ok) setMessage(result.message ?? "Couldn't write an insight.");
            })
          }
        >
          {pending ? "Writing insight…" : hasInsight ? "Refresh insight (new posts since)" : "Explain this trend"}
        </button>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await setTrendSavedAction(trendId, !isSaved);
            if (result.ok) setSaved(!isSaved);
          })
        }
      >
        {isSaved ? "Saved ✓" : "Save trend"}
      </button>
      {message && (
        <p className="form-message" data-status="error" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
