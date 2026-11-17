"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  confirmPublishedAction,
  contentHandoffAction,
  deleteDraftAction,
  duplicateDraftAction,
  regenerateDraftAction,
  reviewDraftAction,
  rewritePostAction,
  saveDraftAction,
} from "@/actions/content";
import { InfoHint } from "@/components/InfoHint";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  CONTENT_TONES,
  type ContentFormat,
  type ContentReview,
  countXChars,
  type DraftStatus,
  MAX_THREAD_POSTS,
  X_POST_LIMIT,
  xIntentUrl,
} from "@/lib/content/types";

type Result = { ok: boolean; message?: string };

/**
 * Edit a draft: per-post counters, one-post AI edits, reorder, review on
 * request, and a manual hand-off to X. Nothing is posted by Scout.
 */
export function DraftEditor({
  draftId,
  format,
  initialTitle,
  initialPosts,
  initialStatus,
  initialReview,
  publishedConfirmed,
}: {
  draftId: string;
  format: ContentFormat;
  initialTitle: string;
  initialPosts: string[];
  initialStatus: DraftStatus;
  initialReview: ContentReview | null;
  publishedConfirmed: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [posts, setPosts] = useState(initialPosts);
  const [status, setStatus] = useState(initialStatus);
  const [review, setReview] = useState(initialReview);
  const [tone, setTone] = useState<string>("conversational");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<null | "regenerate" | "delete">(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [published, setPublished] = useState(publishedConfirmed);

  const save = async (next = { title, posts, status }): Promise<Result> => saveDraftAction(draftId, next);

  function run(task: () => Promise<Result>, success?: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await task();
      setMessage(result.ok ? (success ? { ok: true, text: success } : null) : { ok: false, text: result.message ?? "Something went wrong." });
    });
  }

  /** AI edit of one post: saves your edits first, so nothing typed is lost */
  function rewrite(index: number, action: string) {
    run(async () => {
      const saved = await save();
      if (!saved.ok) return saved;
      const result = await rewritePostAction(draftId, index, action, action === "tone" ? tone : undefined);
      if (result.ok && "text" in result) setPosts((current) => current.map((post, i) => (i === index ? result.text : post)));
      return result;
    });
  }

  function move(index: number, by: -1 | 1) {
    setPosts((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item);
      return next;
    });
  }

  async function copy(index: number) {
    try {
      await navigator.clipboard.writeText(posts[index]);
      setCopied(index);
      void contentHandoffAction(draftId, "copied");
    } catch {
      setMessage({ ok: false, text: "Couldn't copy. Select the text and copy it by hand." });
    }
  }

  const over = posts.some((post) => countXChars(post) > X_POST_LIMIT);

  return (
    <div className="studio-editor" aria-busy={pending}>
      <div className="studio-editor-head">
        <input className="crm-search studio-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} aria-label="Draft name" />
        <label className="crm-status">
          <span className="sr-only">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as DraftStatus)}>
            <option value="draft">Draft</option>
            <option value="ready">Ready</option>
          </select>
        </label>
      </div>

      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}

      <ol className="studio-posts">
        {posts.map((post, index) => {
          const count = countXChars(post);
          return (
            <li key={index} className="crm-panel">
              <div className="studio-post-head">
                <strong>{format === "thread" ? `Post ${index + 1}` : "Post"}</strong>
                <span className="studio-count" data-over={count > X_POST_LIMIT || undefined}>
                  {count} / {X_POST_LIMIT}
                </span>
              </div>
              <textarea
                className="crm-note-input"
                value={post}
                rows={Math.min(10, Math.max(3, Math.ceil(post.length / 60)))}
                onChange={(e) => setPosts((current) => current.map((item, i) => (i === index ? e.target.value : item)))}
                aria-label={format === "thread" ? `Post ${index + 1}` : "Post"}
              />
              <div className="topic-actions">
                {index === 0 && (
                  <button type="button" disabled={pending} onClick={() => rewrite(index, "hook")}>
                    Better hook
                  </button>
                )}
                <button type="button" disabled={pending} onClick={() => rewrite(index, "shorten")}>
                  Shorten
                </button>
                <button type="button" disabled={pending} onClick={() => rewrite(index, "expand")}>
                  Expand
                </button>
                <button type="button" disabled={pending} onClick={() => rewrite(index, "clarity")}>
                  Clearer
                </button>
                <button type="button" disabled={pending} onClick={() => rewrite(index, "alternative")}>
                  Alternative
                </button>
                <button type="button" disabled={pending} onClick={() => rewrite(index, "tone")}>
                  Change tone
                </button>
                <button type="button" onClick={() => copy(index)}>
                  {copied === index ? "Copied ✓" : "Copy"}
                </button>
                {format === "thread" && (
                  <>
                    <button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move post ${index + 1} up`}>
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === posts.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={`Move post ${index + 1} down`}
                    >
                      ↓
                    </button>
                    {posts.length > 1 && (
                      <button type="button" data-danger onClick={() => setPosts((current) => current.filter((_, i) => i !== index))}>
                        Remove
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {format === "thread" && posts.length < MAX_THREAD_POSTS && (
        <div className="topic-actions">
          <button type="button" onClick={() => setPosts((current) => [...current, ""])}>
            + Add a post
          </button>
        </div>
      )}

      <div className="calibration-actions">
        <button type="button" className="primary-button" disabled={pending} onClick={() => run(() => save(), "Saved.")}>
          Save
        </button>
        <label className="crm-status">
          <span className="sr-only">Tone for &ldquo;Change tone&rdquo;</span>
          <select value={tone} onChange={(e) => setTone(e.target.value)} title='Tone used by "Change tone"'>
            {CONTENT_TONES.map((option) => (
              <option key={option} value={option}>
                Tone: {option}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const saved = await save();
              if (!saved.ok) return saved;
              const result = await reviewDraftAction(draftId);
              if (result.ok && "review" in result) setReview(result.review);
              return result;
            })
          }
        >
          Review with Scout
        </button>
        <button type="button" className="text-link" disabled={pending} onClick={() => setConfirm("regenerate")}>
          Regenerate all
        </button>
        <button
          type="button"
          className="text-link"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await duplicateDraftAction(draftId);
              if (result.ok && "draftId" in result) router.push(`/studio/${result.draftId}`);
            })
          }
        >
          Duplicate
        </button>
        <button type="button" className="text-link plan-cancel-link" disabled={pending} onClick={() => setConfirm("delete")}>
          Delete
        </button>
      </div>
      {over && <p className="memory-note">A post is over 280 characters: X only allows that on accounts with longer posts.</p>}

      {review && (
        <section className="ai-insight" aria-labelledby="review-title">
          <h2 id="review-title">
            <span className="ai-tag">AI</span> Scout Content Review
          </h2>
          <p>{review.assessment}</p>
          {review.improvements.length > 0 && (
            <ul className="memory-list">
              {review.improvements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {review.revised && (
            <>
              <h3>Suggested revision</h3>
              {review.revised.map((post, i) => (
                <blockquote key={i} className="opportunity-post">
                  {post}
                </blockquote>
              ))}
              <div className="topic-actions">
                <button type="button" onClick={() => setPosts(review.revised!)}>
                  Use this version (then Save)
                </button>
              </div>
            </>
          )}
          <p className="memory-note">A second opinion, not a prediction of reach.</p>
        </section>
      )}

      <section className="crm-panel" aria-labelledby="publish-title">
        <h2 id="publish-title">Publish on X</h2>
        {format === "post" ? (
          <InfoHint text="How posting works">
            &ldquo;Open in X&rdquo; opens X&apos;s composer with this text. You post it there; Scout can&apos;t see whether you did.
          </InfoHint>
        ) : (
          <InfoHint text="How to post a thread">
            X can&apos;t receive a whole thread from a link. Open the composer with the first post, then add each next post as a
            reply (&ldquo;+&rdquo; in the composer): copy them one by one with the Copy buttons above.
          </InfoHint>
        )}
        <div className="calibration-actions">
          <a
            className="secondary-button"
            href={xIntentUrl(posts[0] ?? "")}
            target="_blank"
            rel="noreferrer"
            onClick={() => void contentHandoffAction(draftId, "opened")}
          >
            {format === "post" ? "Open in X" : "Open X with post 1"}
          </a>
          <button
            type="button"
            className="text-link"
            disabled={pending || published}
            onClick={() =>
              run(async () => {
                const result = await confirmPublishedAction(draftId);
                if (result.ok) setPublished(true);
                return result;
              })
            }
          >
            {published ? "Marked as posted ✓" : "I posted it"}
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "delete" ? "Delete this draft?" : "Rewrite the whole draft?"}
        confirmLabel={confirm === "delete" ? "Delete draft" : "Rewrite"}
        pending={pending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm;
          setConfirm(null);
          if (action === "delete") {
            startTransition(async () => {
              const result = await deleteDraftAction(draftId);
              if (result.ok) router.push("/studio");
              else setMessage({ ok: false, text: result.message });
            });
          } else {
            run(async () => {
              const result = await regenerateDraftAction(draftId);
              if (result.ok && "posts" in result) {
                setPosts(result.posts);
                setReview(null);
              }
              return result;
            });
          }
        }}
      >
        <p className="memory-note">
          {confirm === "delete"
            ? "This can't be undone."
            : "Every post is replaced with a new version. To keep this one, duplicate it first."}
        </p>
      </ConfirmDialog>
    </div>
  );
}
