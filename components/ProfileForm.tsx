"use client";

import { useActionState } from "react";

import type { Profile } from "@/db/schema";
import type { ProfileFormState } from "@/lib/profile/actions";

const fields = [
  {
    name: "displayName",
    label: "Display name",
    hint: "How your name appears across Scout.",
    placeholder: "e.g. Martin",
    multiline: false,
  },
  {
    name: "occupation",
    label: "What do you do?",
    hint: "A short role or area of work.",
    placeholder: "e.g. Founder, designer, engineer",
    multiline: false,
  },
  {
    name: "bio",
    label: "Short bio",
    hint: "Give Scout useful context about your work.",
    placeholder: "What are you building and why?",
    multiline: true,
  },
  {
    name: "targetAudience",
    label: "Target audience",
    hint: "The people you most want to reach.",
    placeholder: "Founders, developers, creators…",
    multiline: true,
  },
  {
    name: "primaryGoal",
    label: "Primary goal",
    hint: "The outcome Scout should optimize for.",
    placeholder: "Grow an audience, find customers…",
    multiline: true,
  },
  {
    name: "knownFor",
    label: "Known for",
    hint: "Topics where your perspective is strongest.",
    placeholder: "AI products, SaaS, product strategy…",
    multiline: true,
  },
] as const;

type ProfileFormProps = {
  profile: Profile | undefined;
  action: (
    state: ProfileFormState,
    formData: FormData,
  ) => Promise<ProfileFormState>;
  title?: string;
  description?: string;
  submitLabel?: string;
};

export function ProfileForm({
  profile,
  action,
  title = "Scout profile",
  description = "This context shapes what Scout finds and how it ranks each conversation.",
  submitLabel = "Save changes",
}: ProfileFormProps) {
  const [state, formAction, pending] = useActionState(action, {
    status: "idle",
  });

  return (
    <form action={formAction} className="profile-form">
      <div className="form-intro">
        <p className="eyebrow">Personalization</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>

      <div className="form-fields">
        {fields.map(({ name, label, hint, placeholder, multiline }) => (
          <label key={name} className="field-row">
            <span className="field-label">
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
            {multiline ? (
              <textarea
                name={name}
                rows={3}
                placeholder={placeholder}
                defaultValue={profile?.[name] ?? ""}
                className="field-control"
              />
            ) : (
              <input
                name={name}
                placeholder={placeholder}
                defaultValue={profile?.[name] ?? ""}
                className="field-control"
              />
            )}
          </label>
        ))}
      </div>

      <div className="form-footer">
        <div aria-live="polite">
          {state.message && (
            <p className="form-message" data-status={state.status}>
              {state.message}
            </p>
          )}
        </div>
        <button type="submit" disabled={pending} className="primary-button">
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
