"use client";

import { useState, useTransition } from "react";

import { setOpportunitySensitivityAction } from "@/actions/opportunities";
import {
  OPPORTUNITY_SENSITIVITIES,
  type OpportunitySensitivity,
  SENSITIVITY_INFO,
} from "@/lib/scout/sensitivity";

/** Settings: how many opportunities the user wants. Saves on choice. */
export function OpportunitySensitivityForm({ initial }: { initial: OpportunitySensitivity }) {
  const [value, setValue] = useState(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(next: OpportunitySensitivity) {
    const previous = value;
    setValue(next);
    setMessage(null);
    startTransition(async () => {
      const result = await setOpportunitySensitivityAction(next);
      if (!result.ok) setValue(previous);
      setMessage({ ok: result.ok, text: result.message });
    });
  }

  return (
    <section className="profile-form">
      <div className="form-intro">
        <p className="eyebrow">Opportunities</p>
        <h2>How many opportunities?</h2>
        <p>
          Scout scores every post 0–100. This sets the score a post needs to reach your feed.
        </p>
      </div>

      <div>
        <fieldset className="sensitivity-options" disabled={pending}>
          <legend className="sr-only">How many opportunities</legend>
          {OPPORTUNITY_SENSITIVITIES.map((option) => {
            const info = SENSITIVITY_INFO[option];
            return (
              <label key={option} className="sensitivity-option">
                <input
                  type="radio"
                  name="sensitivity"
                  value={option}
                  checked={value === option}
                  onChange={() => choose(option)}
                />
                <span>
                  <strong>{info.label}</strong>
                  <small>
                    {info.hint} · score {info.threshold}+
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div aria-live="polite">
          {message && (
            <p className="form-message" data-status={message.ok ? "success" : "error"}>
              {message.text}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
