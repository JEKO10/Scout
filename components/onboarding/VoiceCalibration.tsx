"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveVoiceSamplesAction } from "@/actions/onboarding";
import type { CalibrationPost } from "@/lib/onboarding/calibrationPosts";

const prompts: Record<CalibrationPost["type"], string> = {
  agree: "You'll probably agree with this one. How would you reply?",
  disagree: "You might disagree with this one. How would you push back?",
  experience: "Here you can add your own experience or argument.",
};

export function VoiceCalibration({
  posts,
  initialReplies,
  nextHref,
}: {
  posts: CalibrationPost[];
  initialReplies: string[];
  nextHref: string;
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [replies, setReplies] = useState(() => posts.map((_, i) => initialReplies[i] ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const post = posts[index];
  const last = index === posts.length - 1;

  function finish() {
    const samples = posts
      .map((item, i) => ({ promptPost: item.text, userReply: replies[i].trim() }))
      .filter((sample) => sample.userReply);
    setError(null);
    startTransition(async () => {
      const result = await saveVoiceSamplesAction(samples);
      if (!result.ok) setError(result.message ?? "Couldn't save your replies.");
      else router.push(nextHref);
    });
  }

  return (
    <div className="calibration">
      <p className="eyebrow">
        Voice calibration · {index + 1} of {posts.length}
      </p>
      <p className="calibration-prompt">{prompts[post.type]}</p>

      <blockquote className="opportunity-post">
        <span className="calibration-author">@{post.author}</span>
        {post.text}
      </blockquote>

      <label className="calibration-reply">
        <span>Your reply</span>
        <textarea
          key={post.id}
          className="field-control"
          rows={4}
          maxLength={500}
          autoFocus
          value={replies[index]}
          placeholder="Write it the way you'd actually post it."
          onChange={(event) =>
            setReplies((current) =>
              current.map((reply, i) => (i === index ? event.target.value : reply)),
            )
          }
        />
        <small>{replies[index].length}/280 · write naturally, typos and all</small>
      </label>

      {error && (
        <p className="form-message" data-status="error" role="status">
          {error}
        </p>
      )}

      <div className="calibration-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={index === 0 || pending}
          onClick={() => setIndex(index - 1)}
        >
          Back
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={pending}
          onClick={() => (last ? finish() : setIndex(index + 1))}
        >
          {pending ? "Saving…" : last ? "Save and continue" : "Next"}
        </button>
        <button
          type="button"
          className="text-link calibration-skip"
          disabled={pending}
          onClick={() => router.push(nextHref)}
        >
          Skip calibration
        </button>
      </div>
      <p className="memory-note">
        Skipping is fine: Scout still works, with a less personal voice at first.
      </p>
    </div>
  );
}
