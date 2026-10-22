"use client";

import { useActionState } from "react";

import type { ProfileFormState } from "@/actions/profile";
import type { Profile } from "@/db/schema";

import { XHandleField } from "./XHandleField";

type ProfileFieldName =
  | "displayName"
  | "xHandle"
  | "occupation"
  | "bio"
  | "targetAudience"
  | "primaryGoal"
  | "knownFor";

type ProfileField = {
  name: ProfileFieldName;
  label: string;
  hint: string;
  placeholder: string;
  multiline: boolean;
  options?: readonly string[];
  optional?: boolean;
};

const fields: readonly ProfileField[] = [
  {
    name: "displayName",
    label: "Display name",
    hint: "How your name appears across Scout.",
    placeholder: "e.g. Martin",
    multiline: false,
  },
  {
    name: "xHandle",
    label: "What's your X handle?",
    hint: "Your username on X, with or without the @.",
    placeholder: "e.g. @martinbuilds",
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
    hint: "Optional. Give Scout useful context about your work.",
    placeholder: "What are you building and why?",
    multiline: true,
    optional: true,
  },
  {
    name: "targetAudience",
    label: "Who do you want to reach?",
    hint: "Describe the people you want Scout to find conversations with.",
    placeholder: "Founders, developers, creators…",
    multiline: true,
  },
  {
    name: "primaryGoal",
    label: "What's your primary goal?",
    hint: "Choose the outcome Scout should optimize for.",
    placeholder: "Choose a goal",
    multiline: false,
    options: [
      "Grow my audience",
      "Build my personal brand",
      "Find customers",
      "Build authority",
      "Network with relevant people",
    ],
  },
  {
    name: "knownFor",
    label: "What do you want to be known for?",
    hint: "Optional. Describe the topics where you want to build recognition.",
    placeholder: "AI products, SaaS, product strategy…",
    multiline: true,
    optional: true,
  },
];

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
        {fields.map(
          ({
            name,
            label,
            hint,
            placeholder,
            multiline,
            options,
            optional,
          }) => {
            const currentValue = profile?.[name] ?? "";

            if (name === "xHandle") {
              return (
                <XHandleField
                  key={name}
                  name={name}
                  label={label}
                  hint={hint}
                  placeholder={placeholder.replace("@", "")}
                  defaultValue={currentValue}
                />
              );
            }
            const customOption =
              options && currentValue && !options.includes(currentValue)
                ? currentValue
                : null;

            return (
              <label key={name} className="field-row">
                <span className="field-label">
                  <strong>
                    {label}
                    {!optional && (
                      <span className="required-mark" aria-hidden="true">
                        *
                      </span>
                    )}
                  </strong>
                  <small>{hint}</small>
                </span>
                {options ? (
                  <select
                    name={name}
                    defaultValue={currentValue}
                    required={!optional}
                    className="field-control"
                  >
                    <option value="">{placeholder}</option>
                    {customOption && (
                      <option value={customOption}>{customOption}</option>
                    )}
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : multiline ? (
                  <textarea
                    name={name}
                    rows={3}
                    placeholder={placeholder}
                    defaultValue={currentValue}
                    required={!optional}
                    className="field-control"
                  />
                ) : (
                  <input
                    name={name}
                    placeholder={placeholder}
                    defaultValue={currentValue}
                    required={!optional}
                    className="field-control"
                  />
                )}
              </label>
            );
          },
        )}
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
