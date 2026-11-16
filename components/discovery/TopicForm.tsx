"use client";

import { useState, useTransition } from "react";

import { createTopicAction, suggestKeywordsAction, updateTopicAction } from "@/actions/discovery";

const toList = (text: string) =>
  text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

export type TopicFormValues = {
  id?: string;
  name: string;
  description: string;
  keywords: string[];
  excludedKeywords: string[];
};

/**
 * Create or edit a Smart Discovery topic. "Suggest keywords" asks the AI for
 * search terms the user reviews and edits; saving never starts a search.
 */
export function TopicForm({ initial, onDone }: { initial?: TopicFormValues; onDone?: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [keywords, setKeywords] = useState((initial?.keywords ?? []).join(", "));
  const [excluded, setExcluded] = useState((initial?.excludedKeywords ?? []).join(", "));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [suggesting, startSuggest] = useTransition();
  const [saving, startSave] = useTransition();
  const busy = suggesting || saving;

  function suggest() {
    setMessage(null);
    startSuggest(async () => {
      const result = await suggestKeywordsAction({ name, description });
      if (!result.ok) return setMessage({ ok: false, text: result.message });
      setKeywords(result.keywords.join(", "));
      setExcluded(result.excludedKeywords.join(", "));
      setMessage({ ok: true, text: "Suggested. Review and edit them, then save." });
    });
  }

  function save() {
    setMessage(null);
    startSave(async () => {
      const input = { name, description, keywords: toList(keywords), excludedKeywords: toList(excluded) };
      const result = initial?.id ? await updateTopicAction(initial.id, input) : await createTopicAction(input);
      if (!result.ok) return setMessage({ ok: false, text: result.message });
      setMessage({ ok: true, text: result.message ?? "Saved." });
      if (!initial?.id) {
        setName("");
        setDescription("");
        setKeywords("");
        setExcluded("");
      }
      onDone?.();
    });
  }

  return (
    <div className="topic-form">
      <label>
        Topic name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="SaaS customer acquisition" />
      </label>
      <label>
        What do you want to find?
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={400}
          rows={3}
          placeholder="Founders discussing how hard it is to get their first customers."
        />
      </label>
      <div className="calibration-actions">
        <button type="button" className="secondary-button" onClick={suggest} disabled={busy || name.trim().length < 2}>
          {suggesting ? "Suggesting…" : "Suggest keywords"}
        </button>
      </div>
      <label>
        Keywords (comma separated, any of them can match)
        <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={2} placeholder="first customers, customer acquisition, finding users" />
      </label>
      <label>
        Exclude (optional)
        <input value={excluded} onChange={(e) => setExcluded(e.target.value)} placeholder="hiring, giveaway" />
      </label>
      <p className="memory-note">Up to 8 keywords. Scout searches recent original posts on X during your scans; saving doesn&apos;t start a search.</p>
      <div className="calibration-actions">
        <button type="button" className="primary-button" onClick={save} disabled={busy}>
          {saving ? "Saving…" : initial?.id ? "Save changes" : "Save topic"}
        </button>
        {onDone && initial?.id && (
          <button type="button" className="text-link" onClick={onDone} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
