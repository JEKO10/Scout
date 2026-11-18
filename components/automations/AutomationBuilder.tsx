"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createAutomationAction, editAutomationAction } from "@/actions/automations";
import {
  ACTION_INFO,
  ACTIONS_FOR,
  AUTOMATION_TRIGGERS,
  type AutomationAction,
  type AutomationConditions,
  type AutomationTrigger,
  CONDITIONS_FOR,
  TRIGGER_INFO,
} from "@/lib/automations/types";

export type BuilderValue = {
  name: string;
  description: string;
  trigger: AutomationTrigger;
  conditions: AutomationConditions;
  actions: AutomationAction[];
  enabled: boolean;
  templateKey: string | null;
};

const MULTI: Partial<Record<keyof AutomationConditions, { label: string; options: string[] }>> = {
  intents: { label: "Lead intent", options: ["high", "medium", "low"] },
  leadStatuses: { label: "CRM status", options: ["new", "researching", "contacted", "replied", "qualified", "won", "lost"] },
  trendStatuses: { label: "Trend status", options: ["emerging", "rising", "stable", "declining", "newly_detected"] },
  contentFormats: { label: "Content type", options: ["post", "thread"] },
  contentStatuses: { label: "Content status", options: ["draft", "ready"] },
  taskModules: { label: "Task type (module)", options: ["studio", "calendar", "trends", "opportunities", "leads", "growth", "discovery"] },
};

const NUMBER: Partial<Record<keyof AutomationConditions, { label: string; min: number; max: number; hint: string }>> = {
  minScore: { label: "Minimum score", min: 0, max: 100, hint: "0-100" },
  minRelevance: { label: "Minimum relevance", min: 0, max: 100, hint: "0-100" },
  maxAgeHours: { label: "No older than (hours)", min: 1, max: 720, hint: "e.g. 24" },
};

/** WHEN → IF → THEN, one step at a time; the server validates everything again */
export function AutomationBuilder({ initial, editId, onDone }: { initial: BuilderValue; editId?: string; onDone?: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState<BuilderValue>(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const conditionKeys = CONDITIONS_FOR[value.trigger];
  const allowedActions = ACTIONS_FOR[value.trigger];

  const setCondition = (key: keyof AutomationConditions, next: unknown) =>
    setValue((v) => {
      const conditions = { ...v.conditions } as Record<string, unknown>;
      if (next === undefined || next === "" || (Array.isArray(next) && next.length === 0)) delete conditions[key];
      else conditions[key] = next;
      return { ...v, conditions: conditions as AutomationConditions };
    });

  return (
    <form
      className="automation-builder"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = editId ? await editAutomationAction(editId, value) : await createAutomationAction(value);
          setMessage({ ok: result.ok, text: result.message });
          if (result.ok) {
            onDone?.();
            router.push("/automations");
          }
        });
      }}
    >
      <label className="automation-field">
        <span>Name</span>
        <input value={value.name} maxLength={80} required onChange={(e) => setValue({ ...value, name: e.target.value })} />
      </label>
      <label className="automation-field">
        <span>Description (optional)</span>
        <input value={value.description} maxLength={240} onChange={(e) => setValue({ ...value, description: e.target.value })} />
      </label>

      <fieldset className="automation-step">
        <legend>
          <span className="automation-step-tag">WHEN</span> something happens in Scout
        </legend>
        <select
          value={value.trigger}
          onChange={(e) => {
            const trigger = e.target.value as AutomationTrigger;
            setValue({ ...value, trigger, conditions: {}, actions: value.actions.filter((a) => ACTIONS_FOR[trigger].includes(a)) });
          }}
        >
          {AUTOMATION_TRIGGERS.map((t) => (
            <option key={t} value={t}>
              {TRIGGER_INFO[t].label}: {TRIGGER_INFO[t].when.toLowerCase()}
            </option>
          ))}
        </select>
      </fieldset>

      <fieldset className="automation-step">
        <legend>
          <span className="automation-step-tag">IF</span> it matches (optional)
        </legend>
        {conditionKeys.length === 0 && <p className="memory-note">No conditions for this trigger.</p>}
        <div className="automation-conditions">
          {conditionKeys.map((key) => {
            const number = NUMBER[key];
            const multi = MULTI[key];
            const current = value.conditions[key];
            if (number) {
              return (
                <label key={key} className="automation-field">
                  <span>{number.label}</span>
                  <input
                    type="number"
                    min={number.min}
                    max={number.max}
                    placeholder={number.hint}
                    value={typeof current === "number" ? current : ""}
                    onChange={(e) => setCondition(key, e.target.value === "" ? undefined : Number(e.target.value))}
                  />
                </label>
              );
            }
            if (multi) {
              const selected = (current as string[] | undefined) ?? [];
              return (
                <div key={key} className="automation-field">
                  <span>{multi.label}</span>
                  <div className="automation-chips">
                    {multi.options.map((option) => (
                      <label key={option} className="automation-chip">
                        <input
                          type="checkbox"
                          checked={selected.includes(option)}
                          onChange={(e) => setCondition(key, e.target.checked ? [...selected, option] : selected.filter((o) => o !== option))}
                        />
                        {option.replace("_", " ")}
                      </label>
                    ))}
                  </div>
                </div>
              );
            }
            if (key === "minConfidence") {
              return (
                <label key={key} className="automation-field">
                  <span>Minimum confidence</span>
                  <select value={(current as string) ?? ""} onChange={(e) => setCondition(key, e.target.value || undefined)}>
                    <option value="">Any</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
              );
            }
            return (
              <label key={key} className="automation-field">
                <span>{value.trigger === "high_intent_lead" ? "Post mentions" : "Topic or post mentions"}</span>
                <input value={(current as string) ?? ""} maxLength={60} placeholder="e.g. onboarding" onChange={(e) => setCondition(key, e.target.value || undefined)} />
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="automation-step">
        <legend>
          <span className="automation-step-tag">THEN</span> Scout does this
        </legend>
        <div className="automation-actions">
          {allowedActions.map((action) => (
            <label key={action} className="automation-chip" data-ai={ACTION_INFO[action].ai ? "" : undefined}>
              <input
                type="checkbox"
                checked={value.actions.includes(action)}
                onChange={(e) => setValue({ ...value, actions: e.target.checked ? [...value.actions, action] : value.actions.filter((a) => a !== action) })}
              />
              {ACTION_INFO[action].label}
            </label>
          ))}
        </div>
        <p className="memory-note">Scout never posts, replies, sends messages or follows on X for you. Drafts wait for you to review.</p>
      </fieldset>

      <label className="automation-chip">
        <input type="checkbox" checked={value.enabled} onChange={(e) => setValue({ ...value, enabled: e.target.checked })} />
        Turn on now
      </label>
      <div className="task-controls">
        <button type="submit" className="primary-button" disabled={pending || value.actions.length === 0 || value.name.trim().length < 2}>
          {pending ? "Saving…" : editId ? "Save changes" : "Create automation"}
        </button>
      </div>
      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}
    </form>
  );
}
