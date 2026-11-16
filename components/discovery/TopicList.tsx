"use client";

import { useState, useTransition } from "react";

import { deleteTopicAction, setTopicActiveAction } from "@/actions/discovery";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

import { TopicForm, type TopicFormValues } from "./TopicForm";

export type TopicView = TopicFormValues & { id: string; isActive: boolean; lastSearchedLabel: string | null };

/** The user's topics: pause, resume, edit or delete each one */
export function TopicList({ topics }: { topics: TopicView[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TopicView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setMessage(result.message ?? "Something went wrong.");
    });
  }

  if (topics.length === 0) {
    return <p className="memory-note">No topics yet. Describe what you want to find, and Scout searches X for it in your scans.</p>;
  }

  return (
    <div className="discovery-topics" aria-busy={pending}>
      {message && (
        <p className="form-message" data-status="error" role="status">
          {message}
        </p>
      )}
      {topics.map((topic) =>
        editing === topic.id ? (
          <TopicForm key={topic.id} initial={topic} onDone={() => setEditing(null)} />
        ) : (
          <article key={topic.id} className="topic-card" data-paused={!topic.isActive || undefined}>
            <h3>
              {topic.name}
              {!topic.isActive && " · paused"}
            </h3>
            {topic.description && <p>{topic.description}</p>}
            <div className="topic-keywords">
              {topic.keywords.map((keyword) => (
                <span key={keyword}>{keyword}</span>
              ))}
              {topic.excludedKeywords.map((keyword) => (
                <span key={`-${keyword}`} data-excluded title="Excluded">
                  {keyword}
                </span>
              ))}
            </div>
            <p>{topic.lastSearchedLabel ? `Last searched ${topic.lastSearchedLabel}` : "Not searched yet: runs in your next scan"}</p>
            <div className="topic-actions">
              <button type="button" disabled={pending} onClick={() => run(() => setTopicActiveAction(topic.id, !topic.isActive))}>
                {topic.isActive ? "Pause" : "Resume"}
              </button>
              <button type="button" disabled={pending} onClick={() => setEditing(topic.id)}>
                Edit
              </button>
              <button
                type="button"
                data-danger
                disabled={pending}
                onClick={() => setDeleting(topic)}
              >
                Delete
              </button>
            </div>
          </article>
        ),
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete topic"
        pending={pending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const topic = deleting;
          if (!topic) return;
          run(() => deleteTopicAction(topic.id));
          setDeleting(null);
        }}
      >
        <p className="memory-note">Scout stops searching it. Opportunities it already found stay in your feed.</p>
      </ConfirmDialog>
    </div>
  );
}
