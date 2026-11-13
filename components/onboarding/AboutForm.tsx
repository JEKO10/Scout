"use client";

import { useActionState, useState } from "react";

import type { ProfileFormState } from "@/actions/profile";
import type { Profile } from "@/db/schema";
import {
  AVOID_SUGGESTIONS,
  GOAL_OPTIONS,
  joinList,
  splitList,
  TONE_OPTIONS,
  TOPIC_SUGGESTIONS,
} from "@/lib/onboarding/progress";

type Action = (state: ProfileFormState, formData: FormData) => Promise<ProfileFormState>;

/**
 * Onboarding "About you": the existing Scout Brain answers, as quick choices
 * plus free text. Everything lands in the same profile fields Settings edits.
 */
export function AboutForm({ profile, action }: { profile: Profile; action: Action }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [occupation, setOccupation] = useState(profile.occupation ?? "");
  const [audience, setAudience] = useState(profile.targetAudience ?? "");
  const [goals, setGoals] = useState(splitList(profile.primaryGoal));
  const [topics, setTopics] = useState(splitList(profile.topics));
  const [avoid, setAvoid] = useState(splitList(profile.avoidTopics));
  const [tone, setTone] = useState(splitList(profile.voiceDescription));
  const [touched, setTouched] = useState(false);

  const missing = [
    !displayName.trim() && "your name",
    !occupation.trim() && "what you do",
    goals.length === 0 && "at least one goal",
    !audience.trim() && "who you want to reach",
    topics.length === 0 && "at least one topic",
    tone.length === 0 && "how you want to sound",
  ].filter(Boolean) as string[];

  return (
    <form
      action={formAction}
      className="about-form"
      onSubmit={(event) => {
        setTouched(true);
        if (missing.length) event.preventDefault();
      }}
      noValidate
    >
      {/* Fields this step doesn't ask about keep their saved values */}
      <input type="hidden" name="xHandle" value={profile.xHandle ?? ""} />
      <input type="hidden" name="bio" value={profile.bio ?? ""} />
      <input type="hidden" name="knownFor" value={profile.knownFor ?? ""} />
      <input type="hidden" name="primaryGoal" value={joinList(goals)} />
      <input type="hidden" name="topics" value={joinList(topics)} />
      <input type="hidden" name="avoidTopics" value={joinList(avoid)} />
      <input type="hidden" name="voiceDescription" value={joinList(tone)} />

      <label className="about-field">
        <span>
          Your name <em>required</em>
        </span>
        <input
          name="displayName"
          className="field-control"
          value={displayName}
          maxLength={80}
          autoComplete="name"
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>

      <label className="about-field">
        <span>
          What do you do? <em>required</em>
        </span>
        <textarea
          name="occupation"
          className="field-control"
          rows={2}
          maxLength={120}
          value={occupation}
          placeholder="I'm building an AI SaaS that helps founders grow on social media."
          onChange={(event) => setOccupation(event.target.value)}
        />
      </label>

      <ChipField
        legend="What are your main goals?"
        required
        options={GOAL_OPTIONS}
        value={goals}
        onChange={setGoals}
      />

      <label className="about-field">
        <span>
          Who do you want to reach? <em>required</em>
        </span>
        <input
          name="targetAudience"
          className="field-control"
          value={audience}
          maxLength={300}
          placeholder="Founders and indie hackers building SaaS"
          onChange={(event) => setAudience(event.target.value)}
        />
      </label>

      <ChipField
        legend="What topics do you know or care about?"
        required
        options={TOPIC_SUGGESTIONS}
        value={topics}
        onChange={setTopics}
        custom="Add your own topic"
      />

      <ChipField
        legend="What should Scout avoid?"
        options={AVOID_SUGGESTIONS}
        value={avoid}
        onChange={setAvoid}
        custom="Add something to avoid"
      />

      <ChipField
        legend="How should your replies sound?"
        required
        options={TONE_OPTIONS}
        value={tone}
        onChange={setTone}
        custom="Describe it in your words"
      />

      <div className="about-footer">
        <div aria-live="polite">
          {touched && missing.length > 0 && (
            <p className="form-message" data-status="error">
              Still needed: {missing.join(", ")}.
            </p>
          )}
          {state.status === "error" && state.message && (
            <p className="form-message" data-status="error">
              {state.message}
            </p>
          )}
        </div>
        <button type="submit" className="primary-button" disabled={pending}>
          {pending ? "Saving…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

function ChipField({
  legend,
  options,
  value,
  onChange,
  required = false,
  custom,
}: {
  legend: string;
  options: readonly string[];
  value: string[];
  onChange: (value: string[]) => void;
  required?: boolean;
  /** Placeholder of a free-text input that adds its own chip */
  custom?: string;
}) {
  const [draft, setDraft] = useState("");
  const has = (item: string) => value.some((v) => v.toLowerCase() === item.toLowerCase());
  const toggle = (item: string) =>
    onChange(has(item) ? value.filter((v) => v.toLowerCase() !== item.toLowerCase()) : [...value, item]);
  const extra = value.filter((v) => !options.some((o) => o.toLowerCase() === v.toLowerCase()));

  function add() {
    const item = draft.trim().slice(0, 60);
    if (item && !has(item)) onChange([...value, item]);
    setDraft("");
  }

  return (
    <fieldset className="about-field">
      <legend>
        {legend} {required ? <em>required</em> : <em>optional</em>}
      </legend>
      <div className="chip-row">
        {[...options, ...extra].map((item) => (
          <button
            key={item}
            type="button"
            className="reply-style"
            aria-pressed={has(item)}
            onClick={() => toggle(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {custom && (
        <div className="chip-add">
          <input
            className="field-control"
            value={draft}
            placeholder={custom}
            aria-label={custom}
            maxLength={60}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="secondary-button" onClick={add} disabled={!draft.trim()}>
            Add
          </button>
        </div>
      )}
    </fieldset>
  );
}
