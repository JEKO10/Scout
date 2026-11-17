"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createDraftAction, generateIdeasAction, planDraftAction } from "@/actions/content";
import {
  CONTENT_GOALS,
  CONTENT_LENGTHS,
  CONTENT_TONES,
  type ContentFormat,
  type ContentGoal,
  type ContentLength,
  type ContentTone,
  GOAL_LABEL,
  type IdeaSuggestion,
} from "@/lib/content/types";

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The primary action: pick a goal, get ideas (or bring a topic), write it.
 * Every AI call is an explicit click; nothing generates in the background.
 */
export function CreateContent({
  defaultGoal,
  trend,
  plan = null,
}: {
  defaultGoal: ContentGoal;
  trend: { id: string; label: string } | null;
  /** Started from a calendar day: the new draft goes on that day (09:00) */
  plan?: { date: string; timeZone: string } | null;
}) {
  const router = useRouter();
  const [goal, setGoal] = useState<ContentGoal>(defaultGoal);
  const [topic, setTopic] = useState("");
  const [format, setFormat] = useState<ContentFormat>("post");
  const [tone, setTone] = useState<ContentTone>("conversational");
  const [length, setLength] = useState<ContentLength>("medium");
  const [ideas, setIdeas] = useState<IdeaSuggestion[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [working, setWorking] = useState<"ideas" | "write" | null>(null);

  function write(idea?: IdeaSuggestion) {
    setMessage(null);
    setWorking("write");
    startTransition(async () => {
      const result = await createDraftAction({
        goal,
        format: idea?.format ?? format,
        tone,
        length,
        topic: topic.trim() || undefined,
        idea,
        trendId: trend?.id,
      });
      if (result.ok && "draftId" in result && plan) {
        // The draft exists either way; a failed plan just leaves it unplanned
        await planDraftAction(result.draftId, { date: plan.date, time: "09:00", timeZone: plan.timeZone, goal });
      }
      setWorking(null);
      if (result.ok && "draftId" in result) router.push(`/studio/${result.draftId}${plan ? "?from=calendar" : ""}`);
      else setMessage(result.ok ? "Something went wrong." : result.message);
    });
  }

  return (
    <section className="crm-panel studio-create" aria-labelledby="create-title" aria-busy={pending}>
      <h2 id="create-title">Create content</h2>
      {plan && (
        <p className="memory-note">
          For your calendar: the draft is planned for <strong>{plan.date}</strong> at 09:00 ({plan.timeZone}). You can change the time
          after.
        </p>
      )}
      {trend && (
        <p className="memory-note">
          From the trend <strong>{trend.label}</strong>: ideas and drafts use only what Scout observed about it.
        </p>
      )}
      <div className="studio-options">
        <label>
          Goal
          <select value={goal} onChange={(e) => setGoal(e.target.value as ContentGoal)} disabled={pending}>
            {CONTENT_GOALS.map((option) => (
              <option key={option} value={option}>
                {GOAL_LABEL[option]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as ContentFormat)} disabled={pending}>
            <option value="post">Post</option>
            <option value="thread">Thread</option>
          </select>
        </label>
        <label>
          Tone
          <select value={tone} onChange={(e) => setTone(e.target.value as ContentTone)} disabled={pending}>
            {CONTENT_TONES.map((option) => (
              <option key={option} value={option}>
                {cap(option)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Length
          <select value={length} onChange={(e) => setLength(e.target.value as ContentLength)} disabled={pending}>
            {CONTENT_LENGTHS.map((option) => (
              <option key={option} value={option}>
                {cap(option)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="studio-topic">
        Topic (optional with ideas)
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={300}
          placeholder="What do you want to talk about?"
          disabled={pending}
        />
      </label>
      <div className="calibration-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={pending}
          onClick={() => {
            setMessage(null);
            setWorking("ideas");
            startTransition(async () => {
              const result = await generateIdeasAction({ goal, topic: topic.trim() || undefined, trendId: trend?.id });
              setWorking(null);
              if (result.ok && "ideas" in result) setIdeas(result.ideas);
              else setMessage(result.ok ? "Something went wrong." : result.message);
            });
          }}
        >
          {working === "ideas" ? "Thinking…" : "Generate ideas"}
        </button>
        <button type="button" className="primary-button" disabled={pending || (!topic.trim() && !trend)} onClick={() => write()}>
          {working === "write" ? "Writing…" : "Write it"}
        </button>
      </div>
      {message && (
        <p className="form-message" data-status="error" role="status">
          {message}
        </p>
      )}

      {ideas.length > 0 && (
        <div className="studio-ideas">
          {ideas.map((idea) => (
            <article key={idea.hook} className="topic-card">
              <h3>{idea.hook}</h3>
              <p>{idea.description}</p>
              <p>
                {idea.format === "thread" ? "Thread" : "Post"} · for {idea.audience}
              </p>
              <p className="memory-note">{idea.why}</p>
              <div className="topic-actions">
                <button type="button" disabled={pending} onClick={() => write(idea)}>
                  Write this →
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
