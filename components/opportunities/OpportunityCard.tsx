"use client";

import { useState, useTransition } from "react";

import { setOpportunityStatusAction } from "@/actions/opportunities";
import type { Opportunity } from "@/db/schema";
import { formatRelative } from "@/lib/format";
import { opportunityTier } from "@/services/opportunities/score";

import { type DraftPair, ReplyDrafts } from "./ReplyDrafts";

type Status = Opportunity["status"];

const tierLabels = {
  exceptional: "Exceptional opportunity",
  high: "High opportunity",
  medium: "Medium opportunity",
  low: "Opportunity",
} as const;

export function OpportunityCard({
  opportunity,
  replies = {},
}: {
  opportunity: Pick<
    Opportunity,
    | "id"
    | "authorHandle"
    | "content"
    | "postUrl"
    | "postedAt"
    | "score"
    | "reason"
    | "suggestedAngle"
    | "status"
  >;
  replies?: DraftPair;
}) {
  // Local, not refreshed from the server: a dismissed or replied card stays in
  // place (with Undo) until the user navigates, instead of vanishing mid-read
  const [status, setStatus] = useState<Status>(opportunity.status);
  const [pending, startTransition] = useTransition();
  const score = Math.round(opportunity.score ?? 0);
  const tier = opportunityTier(score);

  function change(next: "new" | "saved" | "dismissed") {
    const previous = status;
    setStatus(next);
    startTransition(async () => {
      const result = await setOpportunityStatusAction(opportunity.id, next);
      if (!result.ok) setStatus(previous);
    });
  }

  if (status === "dismissed") {
    return (
      <article className="opportunity-card" data-dismissed>
        <p>
          Dismissed @{opportunity.authorHandle}&apos;s post. Scout won&apos;t show it again.
        </p>
        <button
          type="button"
          className="text-link"
          disabled={pending}
          onClick={() => change("new")}
        >
          Undo
        </button>
      </article>
    );
  }

  return (
    <article className="opportunity-card" data-tier={tier} aria-busy={pending}>
      <header>
        <p className="opportunity-score">
          <strong>{score}</strong> · {tierLabels[tier]}
        </p>
        {status === "saved" && <span className="opportunity-saved">Saved</span>}
        {status === "replied" && <span className="opportunity-saved">Replied</span>}
      </header>

      <p className="opportunity-author">
        {opportunity.postUrl ? (
          <a href={opportunity.postUrl} target="_blank" rel="noreferrer">
            @{opportunity.authorHandle}
          </a>
        ) : (
          <span>@{opportunity.authorHandle}</span>
        )}
        {opportunity.postedAt && (
          <time dateTime={opportunity.postedAt.toISOString()}>
            {" "}
            · {formatRelative(opportunity.postedAt)}
          </time>
        )}
      </p>

      <blockquote className="opportunity-post">{opportunity.content}</blockquote>

      {opportunity.reason && (
        <section className="opportunity-section">
          <h3>Why you should join</h3>
          <p>{opportunity.reason}</p>
        </section>
      )}
      {opportunity.suggestedAngle && (
        <section className="opportunity-section">
          <h3>Your angle</h3>
          <p>{opportunity.suggestedAngle}</p>
        </section>
      )}

      <ReplyDrafts
        opportunityId={opportunity.id}
        initial={replies}
        onCopied={() => setStatus("replied")}
      />

      <footer>
        {status !== "replied" && (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              aria-pressed={status === "saved"}
              onClick={() => change(status === "saved" ? "new" : "saved")}
            >
              {status === "saved" ? "Unsave" : "Save"}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={() => change("dismissed")}
            >
              Skip
            </button>
          </>
        )}
        {opportunity.postUrl && (
          <a
            href={opportunity.postUrl}
            target="_blank"
            rel="noreferrer"
            className="text-link opportunity-open"
          >
            Open on X <span aria-hidden="true">↗</span>
          </a>
        )}
      </footer>
    </article>
  );
}
