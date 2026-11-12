"use client";

import { useState, useTransition } from "react";

import { rateMissedPostAction } from "@/actions/missedPosts";

type Rating = "strong" | "acceptable" | "weak" | "not_for_me";

const RATINGS: { value: Rating; label: string }[] = [
  { value: "strong", label: "Strong" },
  { value: "acceptable", label: "Acceptable" },
  { value: "weak", label: "Weak" },
  { value: "not_for_me", label: "Not for me" },
];

export type MissedPostItem = {
  id: string;
  author: string;
  excerpt: string;
  url: string;
  sample: "near_threshold" | "random_low";
};

export function MissedPostsReview({ items }: { items: MissedPostItem[] }) {
  const [rated, setRated] = useState<Record<string, Rating>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function rate(item: MissedPostItem, rating: Rating) {
    setFailed(null);
    setRated((previous) => ({ ...previous, [item.id]: rating }));
    startTransition(async () => {
      const result = await rateMissedPostAction({ candidateId: item.id, rating, sample: item.sample });
      if (!result.ok) {
        setRated((previous) => {
          const next = { ...previous };
          delete next[item.id];
          return next;
        });
        setFailed(item.id);
      }
    });
  }

  return (
    <section className="missed-posts" aria-labelledby="missed-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Help Scout learn</p>
          <h2 id="missed-title">Did we miss these?</h2>
        </div>
        <span className="count-label">Scout didn&apos;t show them. Would you reply?</span>
      </div>
      <ul className="missed-list">
        {items.map((item) => (
          <li key={item.id} className="missed-item">
            <div className="missed-post">
              <strong>@{item.author}</strong>
              <p>{item.excerpt}</p>
              <a href={item.url} target="_blank" rel="noreferrer" className="text-link">
                View on X <span aria-hidden="true">↗</span>
              </a>
            </div>
            {rated[item.id] ? (
              <p className="missed-thanks">Thanks, Scout will learn from this.</p>
            ) : (
              <div className="missed-ratings" role="group" aria-label={`Rate the post by @${item.author}`}>
                {RATINGS.map((rating) => (
                  <button
                    key={rating.value}
                    type="button"
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => rate(item, rating.value)}
                  >
                    {rating.label}
                  </button>
                ))}
                {failed === item.id && <small className="form-message" data-status="error">Couldn&apos;t save. Try again.</small>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
