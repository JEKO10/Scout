"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { leadOpenedAction, setLeadSavedAction, startLeadReplyAction } from "@/actions/leads";
import type { LeadIntent, LeadScoreBreakdown } from "@/lib/leads/types";

export type LeadView = {
  id: string;
  authorHandle: string;
  postUrl: string;
  content: string;
  postedLabel: string;
  foundLabel: string;
  intent: LeadIntent;
  score: number;
  breakdown: LeadScoreBreakdown;
  evidence: string;
  reason: string;
  suggestedAction: string;
  saved: boolean;
  topicName: string | null;
};

const INTENT_LABEL: Record<LeadIntent, string> = { high: "High intent", medium: "Medium intent", low: "Low intent" };

/** One possible customer: the evidence, why, and what to do. Everything stays manual. */
export function LeadCard({ lead }: { lead: LeadView }) {
  const router = useRouter();
  const [saved, setSaved] = useState(lead.saved);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const b = lead.breakdown;

  return (
    <article className="opportunity-card lead-card" data-intent={lead.intent} aria-busy={pending}>
      <header>
        <p
          className="opportunity-score"
          title={`Lead score: customer fit ${b.icpFit}/30 · intent ${b.intentStrength}/35 · problem fit ${b.problemFit}/20 · evidence ${b.evidence}/10 · recency ${b.recency}/5. A ranking aid, not a chance of buying.`}
        >
          <strong>{lead.score}</strong> · <span className="lead-intent">{INTENT_LABEL[lead.intent]}</span>
        </p>
        {lead.topicName && <span className="opportunity-source">Discovery · {lead.topicName}</span>}
        {saved && <span className="opportunity-saved">Saved</span>}
      </header>

      <p className="opportunity-author">
        <a href={`https://x.com/${encodeURIComponent(lead.authorHandle)}`} target="_blank" rel="noreferrer">
          @{lead.authorHandle}
        </a>{" "}
        · posted {lead.postedLabel} · found {lead.foundLabel}
      </p>
      <blockquote className="opportunity-post">{lead.content}</blockquote>

      <section className="opportunity-section">
        <h3>Why it could be a lead</h3>
        <p>{lead.reason}</p>
        <p className="lead-evidence">&ldquo;{lead.evidence}&rdquo;</p>
      </section>
      <section className="opportunity-section">
        <h3>Suggested next step</h3>
        <p>{lead.suggestedAction}</p>
      </section>

      <div className="calibration-actions">
        <button
          type="button"
          className="primary-button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setMessage(null);
              const result = await startLeadReplyAction(lead.id);
              if (result.ok) router.push(result.href);
              else setMessage(result.message);
            })
          }
        >
          Generate reply
        </button>
        <a
          href={lead.postUrl}
          target="_blank"
          rel="noreferrer"
          className="secondary-button"
          onClick={() => void leadOpenedAction(lead.id)}
        >
          Open on X
        </a>
        <button
          type="button"
          className="text-link"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const next = !saved;
              const result = await setLeadSavedAction(lead.id, next);
              if (result.ok) setSaved(next);
            })
          }
        >
          {saved ? "Unsave" : "Save lead"}
        </button>
      </div>
      {message && (
        <p className="form-message" data-status="error" role="status">
          {message}
        </p>
      )}
    </article>
  );
}
