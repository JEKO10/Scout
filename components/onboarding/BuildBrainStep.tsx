"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { buildOnboardingBrainAction, type OnboardingMode } from "@/actions/onboarding";

export function BuildBrainStep({
  mode,
  sources,
  nextHref,
}: {
  mode: OnboardingMode;
  /** What the brain will be built from, shown to the user */
  sources: string[];
  nextHref: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function build() {
    setError(null);
    startTransition(async () => {
      const result = await buildOnboardingBrainAction(mode);
      if (result.ok) router.push(nextHref);
      else setError(result.message ?? "Something went wrong.");
    });
  }

  return (
    <div className="calibration">
      <p className="eyebrow">Your Scout Brain</p>
      <p className="calibration-prompt">Scout will build your brain from:</p>
      <ul className="memory-list">
        {sources.map((source) => (
          <li key={source}>
            <strong>{source}</strong>
          </li>
        ))}
      </ul>
      <div className="calibration-actions">
        <button type="button" className="primary-button" disabled={pending} onClick={build}>
          {pending ? (
            <>
              <span className="x-sync-spinner" aria-hidden="true" />
              Building… this takes up to a minute
            </>
          ) : (
            "Build my Scout Brain"
          )}
        </button>
      </div>
      {error && (
        <p className="form-message" data-status="error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
